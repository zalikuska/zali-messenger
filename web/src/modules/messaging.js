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
                // Message being replied to (quote snapshot) and message being
                // edited. Mutually exclusive by construction — the composer shows
                // one context bar, and starting either clears the other.
                replyDraft: null,
                editDraft: null,
            };
        },
    };
})();
