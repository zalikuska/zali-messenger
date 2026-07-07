// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.auth = {
        createState() {
            return {
                session: {
                    username: '',
                    token: null,
                    guest: true,
                },
                auth: {
                    visible: true,
                    loading: false,
                    error: '',
                    mode: 'login',
                    fieldsCleared: false,
                    vaultPassphrase: '',
                    cloudVaultSyncEnabled: false,
                },
                deviceTrust: {
                    current: null,
                    devices: [],
                    exportPackage: '',
                    exportCode: '',
                    importPackage: '',
                    importCode: '',
                    status: '',
                },
            };
        },
    };
})();
