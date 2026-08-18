// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.voice = {
        createState() {
            return {
                supported: !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
                roomId: '',
                roomType: '',
                serverId: '',
                channelId: '',
                targetUser: '',
                inviter: '',
                status: 'idle',
                muted: false,
                // Output-side mute ("deafen"): silences every remote audio/video
                // element regardless of mic state. Independent of `muted` — you can
                // deafen without muting your own mic, same as Discord.
                deafened: false,
                // Whether the call UI is the fullscreen grid (true) or the collapsed
                // top bar (false, default on connect). Reset per-call in
                // resetVoiceState so a new call never inherits the last one's
                // expanded/collapsed choice.
                expanded: false,
                // Wall-clock timestamp the call became active (connected DM, or
                // joined channel) — the collapsed bar and expanded header timers
                // both read from this instead of re-deriving "since when" from
                // callTrack, which channel calls never populate.
                activeSince: 0,
                barTimerInterval: 0,
                videoEnabled: false,
                cameraOn: false,
                cameraRequestInFlight: false,
                localStream: null,
                // In-flight getUserMedia() promise, shared by every concurrent
                // ensureVoiceLocalStream() caller so a group call can't open
                // several parallel mic captures (see ensureVoiceLocalStream).
                localStreamInFlight: null,
                localVideoEl: null,
                // Last getUserMedia() failure, surfaced in the voice panel. A denied
                // mic is otherwise invisible: the room joins, the panel says «В эфире»,
                // and the call simply never negotiates (no local tracks → no offer).
                micError: '',
                screenSharing: false,
                screenShareRequestInFlight: false,
                localScreenStream: null,
                localScreenVideoEl: null,
                // Android-only path: getDisplayMedia() doesn't exist in Android
                // WebView, so native MediaProjection frames are painted onto this
                // canvas and canvas.captureStream() stands in for the browser API.
                screenCaptureFromNative: false,
                screenCaptureRequestId: '',
                screenCaptureCanvas: null,
                screenCaptureCtx: null,
                remoteScreens: new Map(),
                peerConnections: new Map(),
                remoteAudios: new Map(),
                remoteVideos: new Map(),
                participants: [],
                outgoingInvite: null,
                incomingInvite: null,
                socket: null,
                socketReady: false,
                callTrack: null,
                // Set while startDirectCall/acceptIncomingCall is mid-flight so a
                // second click can't open a parallel call setup.
                callSetupInFlight: false,
                // When that latch was taken, so an abandoned setup can be detected
                // instead of blocking every later call (see isVoiceCallSetupBusy).
                callSetupStartedAt: 0,
                negotiationRetryTimer: null,
                negotiationRetries: 0,
                // Re-asserts voice_join while in a room, so a transport blip longer
                // than the server's eviction window doesn't silently drop us.
                presenceTimer: null,
                // Armed only while some peer link is down: re-reads the real
                // connection state instead of waiting for an event that a terminal
                // 'failed' will never emit again (see superviseVoiceLinks).
                linkSupervisorTimer: null,
                // Participant roster the current retry budget was granted for.
                peerRosterKey: '',
                // peer -> tail of that peer's in-order signal application chain.
                signalChains: new Map(),
                audioContext: null,
                audioResumePending: false,
                audioResumeNextAttemptAt: 0,
                playbackUnlocked: false,
                // Teardown for the document-level gesture listeners that retry blocked
                // remote playback (see ensureVoicePlaybackGestureHook). Autoplay policy
                // refuses play() outright when the call was not started by a gesture on
                // this device, and nothing else ever retries it.
                playbackGestureHook: null,
                meterRaf: 0,
                meterLocal: null,
                meterRemote: new Map(),
                meterLevels: {
                    local: 0,
                    remote: 0,
                },
                traceLines: [],
                eventSeq: 0,
                recentEventIds: new Map(),
            };
        },
    };
})();
