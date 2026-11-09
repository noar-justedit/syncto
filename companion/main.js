// syncto module for Bitfocus Companion: start saved jobs, stop and pause
// them, and see on the button whether syncto is comparing, synchronizing,
// done or in error. Talks to Settings › Remote control in syncto.
'use strict'

const { InstanceBase, InstanceStatus, runEntrypoint, combineRgb, Regex } = require('@companion-module/base')
const { SynctoClient } = require('./client')

const COLORS = {
	white: combineRgb(255, 255, 255),
	black: combineRgb(0, 0, 0),
	blue: combineRgb(77, 144, 240),
	green: combineRgb(53, 201, 139),
	red: combineRgb(242, 85, 90),
	orange: combineRgb(242, 160, 61),
	grey: combineRgb(40, 42, 48),
}
const STATES = [
	{ id: 'idle', label: 'Idle' },
	{ id: 'comparing', label: 'Comparing' },
	{ id: 'syncing', label: 'Synchronizing' },
	{ id: 'paused', label: 'Paused' },
]
const RESULTS = [
	{ id: 'done', label: 'Done' },
	{ id: 'error', label: 'Error' },
	{ id: 'refused', label: 'Refused' },
	{ id: 'cancelled', label: 'Cancelled' },
	{ id: 'nothing', label: 'Nothing to do' },
	{ id: 'compared', label: 'Compared' },
]

function fmtEta(s) {
	if (s == null) return ''
	const m = Math.floor(s / 60)
	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}
function fmtSpeed(b) {
	if (!b) return ''
	return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB/s` : `${Math.round(b / 1e6)} MB/s`
}

class SynctoInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.status = { state: 'idle', last: null }
		this.jobList = []
		this.setVariableDefinitions([
			{ variableId: 'state', name: 'State (idle, comparing, syncing, paused)' },
			{ variableId: 'job', name: 'Job running' },
			{ variableId: 'progress', name: 'Progress (%)' },
			{ variableId: 'eta', name: 'Time left' },
			{ variableId: 'speed', name: 'Speed' },
			{ variableId: 'last_result', name: 'Last result' },
			{ variableId: 'last_job', name: 'Last job' },
			{ variableId: 'last_message', name: 'Last message' },
		])
		this.defineAll()
		this.start()
	}

	async destroy() {
		if (this.client) this.client.close()
	}

	async configUpdated(config) {
		this.config = config
		if (this.client) this.client.close()
		this.start()
	}

	getConfigFields() {
		return [
			{ type: 'static-text', id: 'info', width: 12, label: 'In syncto', value: 'Settings › Remote control: turn on Companion, then copy the address, the port and the key here. For Companion on another computer, also turn on "Other machines".' },
			{ type: 'textinput', id: 'host', label: 'Address of the syncto machine', width: 8, default: '127.0.0.1', regex: Regex.HOSTNAME },
			{ type: 'number', id: 'port', label: 'Port', width: 4, default: 7531, min: 1024, max: 65535 },
			{ type: 'textinput', id: 'key', label: 'Key', width: 12, default: '' },
		]
	}

	start() {
		const c = this.config || {}
		if (!c.host || !c.key) {
			this.updateStatus(InstanceStatus.BadConfig, 'Enter the address and the key shown in syncto.')
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		this.client = new SynctoClient({
			host: c.host,
			port: Number(c.port) || 7531,
			key: c.key,
			onStatus: (s) => this.onStatus(s),
			onState: (ok, msg, code) => {
				if (ok) {
					this.updateStatus(InstanceStatus.Ok)
					this.loadJobs()
				} else this.updateStatus(code === 401 ? InstanceStatus.AuthenticationFailure : InstanceStatus.ConnectionFailure, msg)
			},
		})
		this.client.connect()
	}

	async loadJobs() {
		const r = await this.client.jobs()
		if (!r.ok) return
		const next = r.jobs || []
		if (JSON.stringify(next) === JSON.stringify(this.jobList)) return
		this.jobList = next
		this.defineAll()
	}

	onStatus(s) {
		this.status = s
		const p = s.progress || {}
		const l = s.last || {}
		this.setVariableValues({
			state: s.state,
			job: s.job || '',
			progress: p.pct != null ? p.pct : '',
			eta: fmtEta(p.etaSec),
			speed: fmtSpeed(p.bytesPerSec),
			last_result: l.result || '',
			last_job: l.job || '',
			last_message: l.message || '',
		})
		this.checkFeedbacks('state', 'last_result', 'job_running')
	}

	async act(fn) {
		const r = await fn()
		if (!r.ok) this.log('warn', r.error || 'syncto refused.')
		return r
	}

	defineAll() {
		const jobs = this.jobList.map((j) => ({ id: j.id, label: j.name }))
		const jobOption = { type: 'dropdown', id: 'job', label: 'Job', choices: jobs, default: jobs[0] ? jobs[0].id : '', allowCustom: true }
		this.setActionDefinitions({
			sync: {
				name: 'Synchronize a job (compare, then synchronize)',
				options: [jobOption],
				callback: (a) => this.act(() => this.client.run(a.options.job, 'sync')),
			},
			compare: {
				name: 'Compare a job only',
				options: [jobOption],
				callback: (a) => this.act(() => this.client.run(a.options.job, 'compare')),
			},
			stop: { name: 'Stop', options: [], callback: () => this.act(() => this.client.control('stop')) },
			pause: { name: 'Pause', options: [], callback: () => this.act(() => this.client.control('pause')) },
			resume: { name: 'Resume', options: [], callback: () => this.act(() => this.client.control('resume')) },
			refresh_jobs: { name: 'Reload the list of jobs', options: [], callback: () => this.loadJobs() },
		})
		this.setFeedbackDefinitions({
			state: {
				type: 'boolean',
				name: 'syncto is in this state',
				defaultStyle: { bgcolor: COLORS.green, color: COLORS.black },
				options: [{ type: 'dropdown', id: 'state', label: 'State', choices: STATES, default: 'syncing' }],
				callback: (f) => this.status.state === f.options.state,
			},
			job_running: {
				type: 'boolean',
				name: 'This job is running',
				defaultStyle: { bgcolor: COLORS.green, color: COLORS.black },
				options: [jobOption],
				callback: (f) => {
					const j = this.jobList.find((x) => x.id === f.options.job)
					return !!j && this.status.state !== 'idle' && this.status.job === j.name
				},
			},
			last_result: {
				type: 'boolean',
				name: 'The last run ended like this',
				defaultStyle: { bgcolor: COLORS.red, color: COLORS.white },
				options: [{ type: 'dropdown', id: 'result', label: 'Result', choices: RESULTS, default: 'error' }],
				callback: (f) => this.status.state === 'idle' && !!this.status.last && this.status.last.result === f.options.result,
			},
		})
		const presets = {}
		for (const j of this.jobList) {
			presets[`sync_${j.id}`] = {
				type: 'button',
				category: 'Jobs',
				name: `Synchronize ${j.name}`,
				style: { text: `${j.name}\n$(${this.label}:progress)%`, size: '14', color: COLORS.white, bgcolor: COLORS.grey },
				steps: [{ down: [{ actionId: 'sync', options: { job: j.id } }], up: [] }],
				feedbacks: [
					{ feedbackId: 'job_running', options: { job: j.id }, style: { bgcolor: COLORS.green, color: COLORS.black } },
				],
			}
		}
		presets.stop = {
			type: 'button',
			category: 'Control',
			name: 'Stop',
			style: { text: 'STOP', size: '18', color: COLORS.white, bgcolor: COLORS.grey },
			steps: [{ down: [{ actionId: 'stop', options: {} }], up: [] }],
			feedbacks: [{ feedbackId: 'state', options: { state: 'syncing' }, style: { bgcolor: COLORS.red, color: COLORS.white } }],
		}
		presets.status = {
			type: 'button',
			category: 'Control',
			name: 'Status',
			style: { text: `syncto\n$(${this.label}:state)\n$(${this.label}:eta)`, size: '14', color: COLORS.white, bgcolor: COLORS.grey },
			steps: [{ down: [], up: [] }],
			feedbacks: [
				{ feedbackId: 'state', options: { state: 'comparing' }, style: { bgcolor: COLORS.blue, color: COLORS.white } },
				{ feedbackId: 'state', options: { state: 'syncing' }, style: { bgcolor: COLORS.green, color: COLORS.black } },
				{ feedbackId: 'state', options: { state: 'paused' }, style: { bgcolor: COLORS.orange, color: COLORS.black } },
				{ feedbackId: 'last_result', options: { result: 'error' }, style: { bgcolor: COLORS.red, color: COLORS.white } },
				{ feedbackId: 'last_result', options: { result: 'refused' }, style: { bgcolor: COLORS.red, color: COLORS.white } },
			],
		}
		this.setPresetDefinitions(presets)
	}
}

runEntrypoint(SynctoInstance, [])
