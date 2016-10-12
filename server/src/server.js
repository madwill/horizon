'use strict';

const Auth = require('./auth').Auth;
const ClientConnection = require('./client');
const logger = require('./logger');
const {ReliableConn} = require('./reliable');
const schema = require('./schema');
const Request = require('./request');

const fs = require('fs');
const EventEmitter = require('events');

const Joi = require('joi');
const websocket = require('ws');
const Toposort = require('toposort-class');

const protocolName = 'rethinkdb-horizon-v1';
const clientSourcePath = require.resolve('@horizon/client/dist/horizon');
const clientSourceCorePath = require.resolve('@horizon/client/dist/horizon-core');

// Load these lazily (but synchronously)
function lazyLoadSource(sourcePath) {
  if (!this.buffer) {
    this.buffer = fs.readFileSync(clientSourcePath);
  }
  return this.buffer;
}

const clientSource = lazyLoadSource.bind({}, clientSourcePath);
const clientSourceMap = lazyLoadSource.bind({}, `${clientSourcePath}.map`);
const clientSourceCore = lazyLoadSource.bind({}, clientSourceCorePath);
const clientSourceCoreMap = lazyLoadSource.bind({}, `${clientSourceCorePath}.map`);

function handleProtocols(protocols, cb) {
  if (protocols.findIndex((x) => x === protocolName) !== -1) {
    cb(true, protocolName);
  } else {
    logger.debug(`Rejecting client without "${protocolName}" protocol (${protocols}).`);
    cb(false, null);
  }
}

class Server {
  constructor(httpServers, options) {
    this.options = Joi.attempt(options || { }, schema.server);
    this._wsServers = [];
    this._closePromise = null;
    this._methods = {};
    this._middlewareMethods = new Set();
    this._clients = new Set();
    this.events = new EventEmitter();
    this.httpServers = httpServers[Symbol.iterator] ? Array.from(httpServers) : [httpServers];

    this.rdbConnection = new ReliableConn({
      host: this.options.rdb_host,
      port: this.options.rdb_port,
      db: this.options.project_name,
      user: this.options.rdb_user || 'admin',
      password: this.options.rdb_password || '',
      timeout: this.options.rdb_timeout || null,
    });

    this._clearClientsSubscription = this.rdbConnection.subscribe({
      onReady: () => {
        this.events.emit('ready', this);
      },
      onUnready: (err) => {
        this.events.emit('unready', this, err);
        const msg = (err && err.message) || 'Connection became unready.';
        this._clients.forEach((client) => client.close({error: msg}));
        this._clients.clear();
      },
    });

    this._auth = new Auth(this.options.project_name, this.rdbConnection, this.options.auth);

    this._requestHandler = (req, res, next) => {
      let terminal = null;
      const requirements = {};

      this._middlewareMethods.forEach((name) => {
        requirements[name] = true;
      });

      for (const o in req.options) {
        const m = this._methods[o];
        if (!m) {
          next(new Error(`No method to handle option "${o}".`));
          return;
        }

        if (m.type === 'terminal') {
          if (terminal !== null) {
            next(new Error('Multiple terminal methods in request: ' +
                           `"${terminal}", "${o}".`));
            return;
          }
          terminal = o;
        } else {
          requirements[o] = true;
        }
        for (const r of m.requires) {
          requirements[r] = true;
        }
      }

      if (terminal === null) {
        next(new Error('No terminal method was specified in the request.'));
      } else if (requirements[terminal]) {
        next(new Error(`Terminal method "${terminal}" is also a requirement.`));
      } else {
        const ordering = this._getRequirementsOrdering();
        const chain = Object.keys(requirements).sort(
          (a, b) => ordering[a] - ordering[b]);
        chain.push(terminal);

        chain.reduceRight((cb, methodName) =>
          (maybeErr) => {
            if (maybeErr instanceof Error) {
              next(maybeErr);
            } else {
              try {
                this._methods[methodName].handler(new Request(req, methodName), res, cb);
              } catch (e) {
                next(e);
              }
            }
          }, next)();
      }
    };

    const verifyClient = (info, cb) => {
      // Reject connections if we aren't synced with the database
      if (!this.rdbConnection.ready) {
        cb(false, 503, 'Connection to the database is down.');
      } else {
        cb(true);
      }
    };

    const wsOptions = {handleProtocols, verifyClient, path: this.options.path};

    // RSI: only become ready when the websocket servers and the
    // connection are both ready.
    this.httpServers.forEach((server) => {
      const wsServer = new websocket.Server(Object.assign({server}, wsOptions))
        .on('error', (error) => logger.error(`Websocket server error: ${error}`))
        .on('connection', (socket) => {
          try {
            if (!this.rdbConnection.ready) {
              throw new Error('No connection to the database.');
            }

            const client = new ClientConnection(
              socket,
              this._auth,
              this._requestHandler,
              this.events
            );
            this._clients.add(client);
            this.events.emit('connect', client.context());
            socket.once('close', () => {
              this._clients.delete(client);
              this.events.emit('disconnect', client.context());
            });
          } catch (err) {
            logger.error(`Failed to construct client: ${err}`);
            if (socket.readyState === websocket.OPEN) {
              socket.close(1002, err.message.substr(0, 64));
            }
          }
        });

      this._wsServers.push(wsServer);
    });
  }

  auth() {
    return this._auth;
  }

  _invalidateCapabilities() {
    this._capabilities = null;
    this._requirementsOrder = null;
    this._applyCapabilitiesCode = null;
    this._modifiedClientSource = null;
    this._modifiedClientSourceCore = null;
  }

  addMethod(name, rawOptions) {
    const options = Joi.attempt(rawOptions, schema.method);
    if (this._methods[name]) {
      throw new Error(`"${name}" is already registered as a method.`);
    }
    this._invalidateCapabilities();
    this._methods[name] = options;
    if (options.type === 'middleware') {
      this._middlewareMethods.add(name);
    }

  }

  removeMethod(name) {
    const options = this._methods[name];
    if (options) {
      this._invalidateCapabilities();
      this._middlewareMethods.delete(name);
      delete this._methods[name];
    }
  }

  _getRequirementsOrdering() {
    if (!this._requirementsOrdering) {
      const topo = new Toposort();
      for (const m in this._methods) {
        const reqs = this._methods[m].requires;
        topo.add(m, reqs);
        for (const r of reqs) {
          if (!this._methods[r]) {
            throw new Error(
              `Missing method "${r}", which is required by method "${m}".`);
          }
        }
      }
      this._requirementsOrdering = topo.sort().reverse();
    }
    return this._requirementsOrdering;
  }

  // TODO: We close clients in `onUnready` above, but don't wait for them to be closed.
  close() {
    if (!this._closePromise) {
      this._closePromise =
        Promise.all(this._wsServers.map((s) => new Promise((resolve) => {
          s.close(resolve);
        }))).then(() => this.rdbConnection.close());
    }
    return this._closePromise;
  }

  capabilities() {
    if (!this._capabilities) {
      this._capabilities = {}
      for (const key in this._methods) {
        this._capabilities[key] = {type: this._methods[key]};
      }
    }
    return this._capabilities;
  }

  applyCapabilitiesCode() {
    if (!this._applyCapabilitiesCode) {
      this._applyCapabilitiesCode =
        `;{
           let capabilities = ${JSON.stringify(this.capabilities())};
           Object.keys(capabilities).forEach(function (key) {
             Horizon.addOption(key, capabilities[key].type);
           });
         };`;
    }
    return this._applyCapabilitiesCode;
  }

  clientSource() {
    if (!this._modifiedClientSource) {
      this._modifiedClientSource = clientSource() + this.applyCapabilitiesCode();
    }
    return this._modifiedClientSource;
  }

  clientSourceMap() {
    return clientSourceMap();
  }

  clientSourceCore() {
    if (!this._modifiedClientSourceCore) {
      this._modifiedClientSourceCore = clientSourceCore() + this.applyCapabilitiesCode();
    }
    return this._modifiedClientSourceCore;
  }

  clientSourceCoreMap() {
    return clientSourceCoreMap();
  }
}

module.exports = {
  Server,
  protocol: protocolName,
};
