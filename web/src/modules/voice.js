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
                localVideoEl: null,
                screenSharing: false,
                screenShareRequestInFlight: false,
                localScreenStream: null,
                localScreenVideoEl: null,
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
                audioContext: null,
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
            };
        },
    };
})();
