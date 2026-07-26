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
                videoEnabled: false,
                cameraOn: false,
                cameraRequestInFlight: false,
                localStream: null,
                // In-flight getUserMedia() promise, shared by every concurrent
                // ensureVoiceLocalStream() caller so a group call can't open
                // several parallel mic captures (see ensureVoiceLocalStream).
                localStreamInFlight: null,
                localVideoEl: null,
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
                negotiationRetryTimer: null,
                negotiationRetries: 0,
                // Re-asserts voice_join while in a room, so a transport blip longer
                // than the server's 12 s eviction window doesn't silently drop us.
                presenceTimer: null,
                // Participant roster the current retry budget was granted for.
                peerRosterKey: '',
                // peer -> tail of that peer's in-order signal application chain.
                signalChains: new Map(),
                audioContext: null,
                audioResumePending: false,
                masterGainNode: null,
                playbackUnlocked: false,
                meterRaf: 0,
                meterLocal: null,
                meterRemote: new Map(),
                remotePlaybackNodes: new Map(),
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
