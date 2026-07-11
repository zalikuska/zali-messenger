// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.messaging = {
        createState() {
            return {
                chats: {},
                current: null,
                unread: {},
                channelUnread: {},
                mutedChats: {},
                wsOn: false,
                loading: true,
                searchQ: '',
                navMode: 'dm',
                serverChats: {},
                draftAttachments: [],
            };
        },
    };
})();
