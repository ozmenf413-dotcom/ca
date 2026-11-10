(function(window) {
    'use strict';

    /**
     * YemekSepeti API istekleri için R-Sig başlığını oluşturur.
     *
     * @param {object} requestData - İstek detaylarını içeren nesne.
     * @param {string} requestData.url - Tam istek URL'si.
     * @param {string} requestData.eks - Kullanılacak Eks başlığı değeri (örn: 'aaaaq3', 'asdcvc').
     * @param {string} [requestData.body=""] - İstek gövdesi (POST istekleri için, GET için boş).
     * @param {string} [requestData.timestamp] - "yyyy-MM-dd'T'HH:mm:ssZ" formatında zaman damgası. Belirtilmezse otomatik oluşturulur.
     * @param {string} [requestData.random] - Rastgele bir sayı. Belirtilmezse otomatik oluşturulur.
     * @param {string} [requestData.build="260700154"] - Uygulama build numarası.
     * @param {string} [requestData.version="26.7.0"] - Uygulama versiyonu.
     * @param {string} [requestData.custCode=""] - Müşteri kodu (varsa).
     * @returns {object|null} İmza ve detayları içeren bir nesne veya hata durumunda null.
     */
    function generateYemeksepetiRSig(requestData) {

        // 1. --- Gerekli Konfigürasyon ve Haritalar ---
        const CONFIG_MAPS = {
            keys: {
                'amg': '7kK*f0KXK9Ipk2Grcl7GPp%m)xv%xb@i',
                'gig': 'N&g$ZLu9*n0aOUc(GK(6o^Cu*c*yLoTj',
                'asd': 'kzzcWT1ZFqCi4&)Gig#O^*m4Ya5$FDjP',
                'aq3': 'f7a11#XKHvP$!nCBPvB$6*HpV(5BVnAJ',
                'abc': '!xXhPM1zp8aV6Zr7RGBft7B1z6m^7%!#',
                'aaa': 'M&KlANewqa9xnISqDwYOxMs@aY6cpvS6',
                'cvc': '^RRTAYyQqfzwvzbbXLWh!_NLxdJbcxk@',
                'cbc': '^U_!#0nDLJYQ)Sj7qDSWjSq*SKXuO#xz',
                'csc': 'vGp%xdxTS)XUh8gEgO_b_M%#hmeRrhH4',
                'mnp': 'yBbzhv*VETh)FlaY16U!ydUyOO&ujG^5',
                'aaaaq': 'M&KlANewqa9xnISqDwYOxMs@aY6cpvS6',
            },
            templates: {
                'gig': '|{T}_{V}|{U}|{B}_{K}|{P}|{D}_{R}|{C}_',
                'amg': '_{T}|{V}_{B}|{K}|{P}|{R}_{C}|{D}|{U}_',
                'abc': '|{T}_{C}|{U}_{V}|{P}_{K}_{B}|{R}|{D}_',
                'aaa': '|{D}_{B}|{K}|{U}_{V}_{R}|{C}_{T}_{P}|',
                'cvc': '|{V}_{T}|{C}|{P}|{U}|{D}|{K}_{B}_{R}_',
                'cbc': '_{T}_{C}|{R}_{B}_{P}|{U}|{D}|{V}|{K}_',
                'csc': '_{P}|{C}_{R}|{T}|{V}|{K}|{U}|{D}_{B}_',
                'asd': '_{C}|{R}_{P}|{B}|{K}|{V}_{T}|{U}_{D}|',
                'aq3': '|{U}_{C}_{P}_{B}|{T}|{V}|{D}|{R}_{K}_',
                'mnp': '|{V}|{U}_{R}|{T}_{B}_{K}|{D}_{C}|{P}|',
                '3': '_{T}_{R}_{B}_{P}_{K}_{U}_{D}_{V}_{C}_',
            }
        };

        // 2. --- Yardımcı Fonksiyonlar ---
        const helpers = {
            parseEks: function(eks) {
                if (!eks || eks.length < 2) return null;
                const strategies = [
                    () => ({ keyPart: eks.slice(0, -1), templatePart: eks.slice(-1) }),
                    () => ({ keyPart: eks.slice(0, 3), templatePart: eks.slice(3) }),
                    () => ({ keyPart: eks.slice(0, -3), templatePart: eks.slice(-3) }),
                ];
                for (const strategy of strategies) {
                    const result = strategy();
                    const key = CONFIG_MAPS.keys[result.keyPart];
                    const template = CONFIG_MAPS.templates[result.templatePart];
                    if (key && template) return { ...result, key, template };
                }
                return null;
            },
            generateHMAC: function(key, data) {
                // Node.js crypto'dan CryptoJS'e geçiş
                return CryptoJS.HmacSHA256(data, key).toString(CryptoJS.enc.Base64);
            },
            fillTemplate: function(template, values) {
                let result = template;
                for (const [key, value] of Object.entries(values)) {
                    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
                }
                return result;
            }
        };

        // 3. --- Ana Mantık ---
        try {
            // Varsayılan değerler ile kullanıcı tarafından sağlanan verileri birleştir
            const data = {
                build: "260700154",
                version: "26.7.0",
                custCode: "",
                body: "",
                ...requestData, // Kullanıcı verileri varsayılanları ezer
                timestamp: requestData.timestamp || new Date().toISOString().replace(/\.\d+/, '').replace('Z', '+0300'),
                random: requestData.random || Math.random().toString(),
            };

            const eksData = helpers.parseEks(data.eks);
            if (!eksData) throw new Error(`Eks degeri icin eslesme bulunamadi: ${data.eks}`);

            const templateVars = {
                T: data.timestamp,
                V: data.version,
                U: data.url,
                B: data.build,
                K: eksData.key,
                P: `${data.build}|${data.custCode || ''}|${data.random}|${data.timestamp}|${data.version}|`,
                D: data.body || '',
                R: data.random,
                C: data.custCode || ''
            };

            const filledTemplate = helpers.fillTemplate(eksData.template, templateVars);
            const signature = helpers.generateHMAC(eksData.key, filledTemplate);

            return {
                success: true,
                signature,
                eks: data.eks,
                ...eksData,
                templateString: filledTemplate,
            };

        } catch (error) {
            console.error("R-Sig olusturulurken hata:", error);
            return { success: false, error: error.message };
        }
    }

    // Fonksiyonu global context'e ekle
    if (typeof window !== 'undefined') {
        // Browser context (inject.js için)
        window.generateYemeksepetiRSig = generateYemeksepetiRSig;
    } else {
        // Service Worker context (background.js için)
        self.generateYemeksepetiRSig = generateYemeksepetiRSig;
    }

})(typeof window !== 'undefined' ? window : self); 