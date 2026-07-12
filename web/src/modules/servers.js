// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.servers = {
        createState() {
            return {
                activeServer: null,
                activeChannel: null,
                servers: [],
                publicServers: [],
                serverModal: {
                    mode: 'create',
                    serverId: null,
                    activeSection: 'overview',
                    colorPickers: {},
                    roleCreateOpen: false,
                    channelCreateOpen: false,
                    members: [],
                    roles: [],
                    channels: [],
                    draftRoles: [],
                    createDraft: null,
                    joinLink: '',
                    selectedChannelId: null,
                    channelPermissions: [],
                    loading: false,
                    saving: false,
                    error: '',
                },
            };
        },
    };
})();
