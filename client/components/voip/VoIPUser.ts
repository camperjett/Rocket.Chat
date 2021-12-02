/**
 * Class representing SIP UserAgent
 * @remarks
 * This class encapsulates all the details of sip.js and exposes
 * a very simple functions and callback handlers to the outside world.
 * This class thus abstracts user from Browser specific media details as well as
 * SIP specific protol details.
 */

import { Emitter } from '@rocket.chat/emitter';
import {
	UserAgent,
	UserAgentOptions,
	// UserAgentDelegate,
	Invitation,
	InvitationAcceptOptions,
	Session,
	SessionState,
	Registerer,
} from 'sip.js';
import { OutgoingRequestDelegate } from 'sip.js/lib/core';
import { SessionDescriptionHandler } from 'sip.js/lib/platform/web';

import { ClientLogger } from '../../../lib/ClientLogger';
import { Operation } from './Operations';
import { IMediaStreamRenderer, VoIPUserConfiguration } from './VoIPUserConfiguration';
import { CallStates } from './definitions/CallStates';
import { ICallerInfo } from './definitions/ICallerInfo';
import { UserState } from './definitions/UserState';
import { VoIpCallerInfo, IState } from './definitions/VoIpCallerInfo';
import { VoipEvents } from './definitions/VoipEvents';
import Stream from './media/Stream';

export class VoIPUser extends Emitter<VoipEvents> implements OutgoingRequestDelegate {
	state: IState = {
		isReady: false,
		enableVideo: false,
	};

	private session: Session | undefined;

	private remoteStream: Stream | undefined;

	userAgentOptions: UserAgentOptions = {};

	userAgent: UserAgent | undefined;

	registerer: Registerer | undefined;

	mediaStreamRendered?: IMediaStreamRenderer;

	logger: ClientLogger;

	private _callState: CallStates = 'IDLE';

	private _callerInfo: ICallerInfo | undefined;

	private _userState: UserState = UserState.IDLE;

	get callState(): CallStates {
		return this._callState;
	}

	get callerInfo(): VoIpCallerInfo {
		if (this.callState === 'IN_CALL') {
			if (!this._callerInfo) {
				throw new Error('[VoIPUser callerInfo] invalid state');
			}
			return {
				state: 'IN_CALL',
				callerInfo: this._callerInfo,
				userState: this._userState,
			};
		}
		return {
			state: this.callState,
			userState: this._userState,
		};
	}

	private _opInProgress: Operation = Operation.OP_NONE;

	get operationInProgress(): Operation {
		return this._opInProgress;
	}

	get userState(): UserState | undefined {
		return this._userState;
	}

	/* Media Stream functions begin */
	/** The local media stream. Undefined if call not answered. */
	get localMediaStream(): MediaStream | undefined {
		const sdh = this.session?.sessionDescriptionHandler;
		if (!sdh) {
			return undefined;
		}
		if (!(sdh instanceof SessionDescriptionHandler)) {
			throw new Error('Session description handler not instance of web SessionDescriptionHandler');
		}
		return sdh.localMediaStream;
	}

	/* Media Stream functions end */
	constructor(
		private readonly config: VoIPUserConfiguration,
		mediaRenderer?: IMediaStreamRenderer,
	) {
		super();
		this.mediaStreamRendered = mediaRenderer;
		this.logger = new ClientLogger('VoIPUser');

		this.on('connected', () => {
			this.state.isReady = true;
		});

		this.on('connectionerror', () => {
			this.state.isReady = false;
		});
	}

	/* UserAgentDelegate methods end */
	/* OutgoingRequestDelegate methods begin */
	onAccept(): void {
		this.logger.info('onAccept()');
		if (this._opInProgress === Operation.OP_REGISTER) {
			this._callState = 'REGISTERED';
			this.emit('registered');
			this.emit('stateChanged');
		}
		if (this._opInProgress === Operation.OP_UNREGISTER) {
			this._callState = 'UNREGISTERED';
			this.emit('unregistered');
			this.emit('stateChanged');
		}
	}

	onReject(error: any): void {
		this.logger.info('onReject()');
		if (this._opInProgress === Operation.OP_REGISTER) {
			this.emit('registrationerror', error);
		}
		if (this._opInProgress === Operation.OP_UNREGISTER) {
			this.emit('unregistrationerror', error);
		}
	}
	/* OutgoingRequestDelegate methods end */

	private async handleIncomingCall(invitation: Invitation): Promise<void> {
		this.logger.info('handleIncomingCall()');
		if (this.callState === 'REGISTERED') {
			this._opInProgress = Operation.OP_PROCESS_INVITE;
			this._callState = 'OFFER_RECEIVED';
			this._userState = UserState.UAS;
			this.session = invitation;
			this.setupSessionEventHandlers(invitation);
			const callerInfo: ICallerInfo = {
				callerId: invitation.remoteIdentity.uri.user ? invitation.remoteIdentity.uri.user : '',
				callerName: invitation.remoteIdentity.displayName,
				host: invitation.remoteIdentity.uri.host,
			};
			this._callerInfo = callerInfo;
			this.emit('incomingcall', callerInfo);
			this.emit('stateChanged');
			return;
		}

		this.logger.warn('handleIncomingCall() Rejecting. Incorrect state', this.callState);
		await invitation.reject();
	}

	/**
	 * Sets up an listener handler for handling session's state change
	 * @remarks
	 * Called for setting up various state listeners. These listeners will
	 * decide the next action to be taken when the session state changes.
	 * e.g when session.state changes from |Establishing| to |Established|
	 * one must set up local and remote media rendering.
	 *
	 * This class handles such session state changes and takes necessary actions.
	 */

	private setupSessionEventHandlers(session: Session): void {
		this.logger.info('setupSessionEventHandlers()');
		this.session?.stateChange.addListener((state: SessionState) => {
			if (this.session !== session) {
				return; // if our session has changed, just return
			}
			switch (state) {
				case SessionState.Initial:
					break;
				case SessionState.Establishing:
					break;
				case SessionState.Established:
					this._opInProgress = Operation.OP_NONE;
					this._callState = 'IN_CALL';
					this.setupRemoteMedia();
					this.emit('callestablished');
					this.emit('stateChanged');
					break;
				case SessionState.Terminating:
				// fall through
				case SessionState.Terminated:
					this.session = undefined;
					this._callState = 'REGISTERED';
					this._opInProgress = Operation.OP_NONE;
					this._userState = UserState.IDLE;
					this.emit('callterminated');
					this.remoteStream?.clear();
					this.emit('stateChanged');
					break;
				default:
					throw new Error('Unknown session state.');
			}
		});
	}

	onTrackAdded(_event: any): void {
		this.logger.debug('onTrackAdded()');
	}

	onTrackRemoved(_event: any): void {
		this.logger.debug('onTrackRemoved()');
	}

	/**
	 * Carries out necessary steps for rendering remote media whe
	 * call gets established.
	 * @remarks
	 * Sets up Stream class and plays the stream on given Media element/
	 * Also sets up various event handlers.
	 */
	private setupRemoteMedia(): any {
		this.logger.debug('setupRemoteMedia()');
		if (!this.session) {
			this.logger.error('setupRemoteMedia() : Sesson does not exist');
			throw new Error('Session does not exist.');
		}
		const sdh = this.session?.sessionDescriptionHandler;
		if (!sdh) {
			this.logger.error('setupRemoteMedia() : no session description');
			return undefined;
		}
		if (!(sdh instanceof SessionDescriptionHandler)) {
			this.logger.error('setupRemoteMedia() : Unknown error');
			throw new Error('Session description handler not instance of web SessionDescriptionHandler');
		}

		const remoteStream = sdh.remoteMediaStream;
		if (!remoteStream) {
			this.logger.error('setupRemoteMedia() : Remote stream not found');
			throw new Error('Remote media stream undefiend.');
		}

		this.remoteStream = new Stream(remoteStream);
		const mediaElement = this.mediaStreamRendered?.remoteMediaElement;

		if (mediaElement) {
			this.remoteStream.init(mediaElement);
			this.remoteStream.onTrackAdded(this.onTrackAdded.bind(this));
			this.remoteStream.onTrackRemoved(this.onTrackRemoved.bind(this));
			this.remoteStream.play();
		}
	}

	/**
	 * Configures and initializes sip.js UserAgent
	 * call gets established.
	 * @remarks
	 * This class configures transport properties such as websocket url, passed down in config,
	 * sets up ICE servers,
	 * SIP UserAgent options such as userName, Password, URI.
	 * Once initialized, it starts the userAgent.
	 */

	async init(): Promise<void> {
		this.logger.debug('init()');
		const sipUri = `sip:${this.config.authUserName}@${this.config.sipRegistrarHostnameOrIP}`;
		this.logger.verbose('init() endpoint identity = ', sipUri);
		const transportOptions = {
			server: this.config.webSocketURI,
			connectionTimeout: 10, // Replace this with config
			keepAliveInterval: 20,
			// traceSip: true
		};
		const sdpFactoryOptions = {
			iceGatheringTimeout: 10,
			peerConnectionConfiguration: {
				iceServers: this.config.iceServers,
			},
		};
		this.userAgentOptions = {
			delegate: {
				/* UserAgentDelegate methods begin */
				onConnect: (): void => {
					this._callState = 'SERVER_CONNECTED';
					this.logger.info('onConnect() Connected');

					this.emit('connected');

					if (this.userAgent) {
						this.registerer = new Registerer(this.userAgent);
					}
				},
				onDisconnect: (error: any): void => {
					this.logger.info('onDisconnect() Disconnected');
					if (error) {
						this.emit('connectionerror', error);
						this.logger.warn('onDisconnect() Error', error);
					}
				},
				onInvite: async (invitation: Invitation): Promise<void> => {
					this.logger.info('onDisconnect() Disconnected');
					await this.handleIncomingCall(invitation);
				},
			},
			authorizationPassword: this.config.authPassword,
			authorizationUsername: this.config.authUserName,
			uri: UserAgent.makeURI(sipUri),
			transportOptions,
			sessionDescriptionHandlerFactoryOptions: sdpFactoryOptions,
			logConfiguration: false,
		};

		this.userAgent = new UserAgent(this.userAgentOptions);
		this._opInProgress = Operation.OP_CONNECT;
		await this.userAgent.start();
	}

	static async create(
		config: VoIPUserConfiguration,
		mediaRenderer?: IMediaStreamRenderer,
	): Promise<VoIPUser> {
		const voip = new VoIPUser(config, mediaRenderer);
		await voip.init();
		return voip;
	}

	/**
	 * Public method called from outside to register the SIP UA with call server.
	 * @remarks
	 */

	register(): void {
		this.logger.info('register()');
		this._opInProgress = Operation.OP_REGISTER;
		this.registerer?.register({
			requestDelegate: this,
		});
	}

	/**
	 * Public method called from outside to unregister the SIP UA.
	 * @remarks
	 */

	unregister(): void {
		this.logger.info('unregister()');
		this._opInProgress = Operation.OP_UNREGISTER;
		this.registerer?.unregister({
			all: true,
			requestDelegate: this,
		});
	}
	/**
	 * Public method called from outside to accept incoming call.
	 * @remarks
	 */

	async acceptCall(mediaRenderer?: IMediaStreamRenderer): Promise<void> {
		if (mediaRenderer) {
			this.mediaStreamRendered = mediaRenderer;
		}
		this.logger.info('acceptCall()');
		// Call state must be in offer_received.
		if (
			this._callState === 'OFFER_RECEIVED' &&
			this._opInProgress === Operation.OP_PROCESS_INVITE
		) {
			this._callState = 'ANSWER_SENT';
			const invitationAcceptOptions: InvitationAcceptOptions = {
				sessionDescriptionHandlerOptions: {
					constraints: {
						audio: true,
						video: !!this.config.enableVideo,
					},
				},
			};
			this.logger.debug(
				'acceptCall() constraints = ',
				JSON.stringify(invitationAcceptOptions.sessionDescriptionHandlerOptions),
			);
			// Somethingis wrong, this session is not an instance of INVITE
			if (!(this.session instanceof Invitation)) {
				this.logger.error('acceptCall() Session instance error');
				throw new Error('Session not instance of Invitation.');
			}
			return this.session.accept(invitationAcceptOptions);
		}
		this.logger.error('acceptCall() Unknown error');
		throw new Error('Something went wront');
	}

	/**
	 * Public method called from outside to reject a call.
	 * @remarks
	 */
	rejectCall(): Promise<unknown> {
		this.logger.info('rejectCall()');

		if (!this.session) {
			this.logger.warn('rejectCall() Session does not exist');
			throw new Error('Session does not exist.');
		}
		if (this._callState !== 'OFFER_RECEIVED') {
			this.logger.warn('rejectCall() Incorrect call State', this.callState);
			throw new Error(`Incorrect call State = ${this.callState}`);
		}
		if (!(this.session instanceof Invitation)) {
			this.logger.warn('rejectCall() Session not instance of Invitation.');
			throw new Error('Session not instance of Invitation.');
		}
		return this.session.reject();
	}

	/**
	 * Public method called from outside to end a call.
	 * @remarks
	 */
	async endCall(): Promise<any> {
		if (!this.session) {
			this.logger.warn('rejectCall() Session does not exist');
			throw new Error('Session does not exist.');
		}
		if (this._callState !== 'ANSWER_SENT' && this._callState !== 'IN_CALL') {
			this.logger.warn('rejectCall() Incorrect call State', this.callState);
			throw new Error(`Incorrect call State = ${this.callState}`);
		}
		switch (this.session.state) {
			case SessionState.Initial:
				if (this.session instanceof Invitation) {
					return this.session.reject();
				}
				this.logger.warn('rejectCall() Session not instance of Invitation.');
				throw new Error('Session not instance of Invitation.');
			case SessionState.Establishing:
				if (this.session instanceof Invitation) {
					return this.session.reject();
				}
				this.logger.warn('rejectCall() Session not instance of Invitation.');
				throw new Error('Session not instance of Invitation.');
			case SessionState.Established:
				return this.session.bye();
			case SessionState.Terminating:
				break;
			case SessionState.Terminated:
				break;
			default:
				this.logger.warn('rejectCall() Unknown state');
				throw new Error('Unknown state');
		}
		this.logger.debug('ended');
	}

	/* CallEventDelegate implementation end */
	isReady(): boolean {
		return this.state.isReady;
	}
}
