// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.contacts = {
        createState() {
            return {
                users: [],
                contacts: [],
                contactAddMode: false,
            };
        },
    };
})();
