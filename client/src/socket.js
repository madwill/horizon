import { AsyncSubject } from 'rxjs/AsyncSubject'
import { Subject } from 'rxjs/Subject'
import { BehaviorSubject } from 'rxjs/BehaviorSubject'
import { WebSocketSubject } from 'rxjs/observable/dom/WebSocketSubject'
import { Observable } from 'rxjs/Observable'
import { Subscription } from 'rxjs/Subscription'
import 'rxjs/add/observable/merge'
import 'rxjs/add/observable/timer'
import 'rxjs/add/operator/filter'
import 'rxjs/add/operator/share'
import 'rxjs/add/operator/ignoreElements'
import 'rxjs/add/operator/concat'
import 'rxjs/add/operator/takeWhile'
import 'rxjs/add/operator/publish'
import jsonpatch from 'jsonpatch'

import { serialize, deserialize } from './serialization.js'

const PROTOCOL_VERSION = 'rethinkdb-horizon-v1'

// When the socket is not connected
const STATUS_DISCONNECTED = { type: 'disconnected' }
// After the websocket is opened and handshake is completed
const STATUS_READY = { type: 'ready' }
// After unconnected, maybe before or after connected. Any socket level error
// TODO: is this necessary?  this should not last long - may become DISCONNECTED shortly after?
const STATUS_ERROR = { type: 'error' }

class ProtocolError extends Error {
  constructor(msg, errorCode) {
    super(msg)
    this.errorCode = errorCode
  }
  toString() {
    return `${this.message} (Code: ${this.errorCode})`
  }
}


// Wraps native websockets with a Subject, which is both an Subscriber
// and an Observable (it is bi-directional after all!). This version
// is based on the rxjs.observable.dom.WebSocketSubject implementation.
export class HorizonSocket {
  constructor({
    url,              // Full url to connect to
    tokenStorage, // function that returns handshake to emit
    keepaliveSec = 60,   // seconds between keepalive messages
    WebSocketCtor = WebSocket,    // optionally provide a WebSocket constructor
  } = {}) {
    this.socket = new WebSocketSubject({
      url,
      protocol: PROTOCOL_VERSION,
      WebSocketCtor,
      resultSelector: (msg) => deserialize(JSON.parse(msg.data)),
    })

    // This is used to emit status changes that others can hook into.
    this.tokenStorage = tokenStorage;
    this.status = new BehaviorSubject()
    this.reinitialize()

    // TODO: only run the timer while connected
    const keepalive = Observable.timer(keepaliveSec * 1000, keepaliveSec * 1000)
      .map(() => {
        if (this.status.value === STATUS_READY) {
          this.makeRequest(null, 'keepalive').subscribe()
        }
      })
      .subscribe()

    // A map from requestId to an object with metadata about the
    // request. Eventually, this should allow re-sending requests when
    // reconnecting.
    this.requests = new Map()
  }

  connect(onError) {
    if (!this.subscription) {
      this.subscription = this.socket.subscribe({
        next: (response) => this.handleResponse(response),
        error: (err) => onError(err),
      })
      this.subscription.add(() => this.reinitialize())
      this.sendHandshake(this.tokenStorage)
    }
  }

  disconnect() {
    if (this.subscription) {
      this.subscription.unsubscribe()
    }
  }

  reinitialize() {
    this.requestCounter = 0 // TODO: make sure we reassign requestIds when resuming requests
    this.subscription = null
    this.handshake = new AsyncSubject()
    this.status.next(STATUS_DISCONNECTED)
  }

  send(value) {
    const request = JSON.stringify(serialize(value))
    this.socket.next(request)
  }

  sendHandshake(tokenStorage) {
    const req = this.makeRequest(tokenStorage.handshake(), 'handshake');
    req.subject.subscribe({
      next: (message) => {
        if (message.error) {
          this.handshake.error(new ProtocolError(message.error, message.errorCode))
          this.status.next(STATUS_ERROR)
          if (message.error.includes('JsonWebTokenError') ||
              message.error.includes('TokenExpiredError')) {
            tokenStorage.remove()
          }
        } else {
          this.handshake.next(message)
          this.handshake.complete()
          this.status.next(STATUS_READY)
          if (message.token) {
            tokenStorage.set(message.token)
          }
        }
      },
      error: (err) => {
        this.handshake.error(err)
        this.status.next(STATUS_ERROR)
      },
    })
  }

  // Incorporates shared logic between the inital handshake request and
  // all subsequent requests.
  // * Generates a request id and filters by it
  // * Send `end_subscription` when observable is unsubscribed
  makeRequest(options, type) {
    const requestId = this.requestCounter++
    const req = {
      message: {requestId},
      data: {},
      subject: new Subject(),
    }

    if (options) { req.message.options = options }
    if (type) { req.message.type = type }

    this.requests.set(requestId, req)
    this.send(req.message)
    return req
  }

  cleanupRequest(requestId) {
    const req = this.requests.get(requestId)
    if (req) {
      this.requests.delete(requestId)
      req.subject.complete()
    }
  }

  handleResponse(message) {
    const req = this.requests.get(message.requestId)
    if (req) {
      req.subject.next(message)
      if (message.complete) {
        this.cleanupRequest(message.requestId)
      }
    }
  }

  // Wrapper around the makeRequest with the following additional
  // features we need for horizon's protocol:
  // * Sends handshake on subscription if it hasn't happened already
  // * Wait for the handshake to complete before sending the request
  // * Errors when a document with an `error` field is received
  // * Completes when `state: complete` is received
  // * Reference counts subscriptions
  hzRequest(options) {
    this.connect() // Make sure we are connected.  TODO: lazily disconnect if no activity?
    const req = this.makeRequest(options);
    return req.subject.concatMap((response) => {
        if (response.error) {
          throw new ProtocolError(response.error, response.errorCode)
        }

        if (response.patch) {
          // TODO: are there any cases where it is a problem that we
          // have already 'deserialized' the data before applying the patch?
          req.data = jsonpatch.apply_patch(req.data, response.patch)
        }
        if (Boolean(req.data.synced)) {
          switch (req.data.type) {
          case 'value':
            return [req.data.val]
          case 'set':
            return [Object.values(data.val)]
          default:
            throw new Error(`Unrecognized data type: ${data.type}.`)
          }
        }
        return []
      })
      /* or...
      .map((response) => {
        if (response.error) {
          throw new Error(response.error)
        }

        if (response.patch) {
          req.data = jsonpatch.apply_patch(req.data, response.patch)
        }
        return req.data
      })
      .filter((data) => Boolean(data.synced))
      .map((data) => {
        if (data.type === 'value') { return data.val }
        if (data.type === 'set') { return Object.values(data.val) }
        throw new Error(`Unrecognized data type: ${data.type}.`)
      })
      */
      .share()
  }
}
