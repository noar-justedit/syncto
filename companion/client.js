// syncto remote control client, for the Companion module.
// It speaks to the server in syncto (src/main/remote.js): HTTP for the
// commands, a stream of server-sent events for the state. Kept apart from
// Companion so the syncto test suite runs it against a real server.
'use strict'

const http = require('http')

class SynctoClient {
	// opts: { host, port, key, onStatus(status), onState(ok, message) }
	constructor(opts) {
		this.o = opts
		this.stream = null
		this.retry = null
		this.closed = false
	}

	request(method, path) {
		return new Promise((resolve) => {
			const req = http.request(
				{
					host: this.o.host,
					port: this.o.port,
					path,
					method,
					timeout: 8000,
					headers: { Authorization: `Bearer ${this.o.key}` },
				},
				(res) => {
					let data = ''
					res.setEncoding('utf8')
					res.on('data', (c) => (data += c))
					res.on('end', () => {
						let body = {}
						try {
							body = JSON.parse(data)
						} catch (_) {
							body = { ok: false, error: 'syncto sent an answer that is not JSON.' }
						}
						resolve(Object.assign({ status: res.statusCode }, body))
					})
				},
			)
			req.on('timeout', () => req.destroy(new Error('syncto did not answer in time.')))
			req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }))
			req.end()
		})
	}

	jobs() {
		return this.request('GET', '/api/jobs')
	}
	run(jobId, action) {
		return this.request('POST', `/api/jobs/${encodeURIComponent(jobId)}/${action === 'compare' ? 'compare' : 'sync'}`)
	}
	control(act) {
		return this.request('POST', `/api/${act}`)
	}

	// Follows the state; reconnects every few seconds while syncto is away.
	connect() {
		this.closed = false
		const req = http.request(
			{
				host: this.o.host,
				port: this.o.port,
				path: '/api/events',
				method: 'GET',
				headers: { Authorization: `Bearer ${this.o.key}`, Accept: 'text/event-stream' },
			},
			(res) => {
				if (res.statusCode !== 200) {
					this.o.onState(false, res.statusCode === 401 ? 'Wrong key: copy it from syncto, Settings, Remote control.' : `syncto answered ${res.statusCode}.`, res.statusCode)
					res.resume()
					return this.later()
				}
				this.o.onState(true, '')
				let buf = ''
				res.setEncoding('utf8')
				res.on('data', (chunk) => {
					buf += chunk
					let i
					while ((i = buf.indexOf('\n\n')) >= 0) {
						const block = buf.slice(0, i)
						buf = buf.slice(i + 2)
						const line = block.split('\n').find((l) => l.startsWith('data: '))
						if (!line) continue
						try {
							this.o.onStatus(JSON.parse(line.slice(6)))
						} catch (_) {
							/* a broken line is skipped */
						}
					}
				})
				res.on('end', () => {
					this.o.onState(false, 'syncto closed the connection.')
					this.later()
				})
			},
		)
		req.on('error', (err) => {
			this.o.onState(false, `syncto is not reachable (${err.code || err.message}). Is it open, with Remote control on?`)
			this.later()
		})
		req.end()
		this.stream = req
	}

	later() {
		if (this.closed || this.retry) return
		this.retry = setTimeout(() => {
			this.retry = null
			if (!this.closed) this.connect()
		}, 3000)
	}

	close() {
		this.closed = true
		if (this.retry) clearTimeout(this.retry)
		this.retry = null
		if (this.stream) this.stream.destroy()
		this.stream = null
	}
}

module.exports = { SynctoClient }
