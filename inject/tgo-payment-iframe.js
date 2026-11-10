// v48: DEVRE DIŞI — payment iframe'e script inject edilmiyor.
// Bu script'in yaptığı patch'ler (options POST 200 mock, postMessage patch vb.)
// doğal ödeme akışını bozup "Onayla ve Bitir" butonunu pasif tutuyordu.
// manifest.json'dan da içerik-script kaydı KALDIRILDI (referans için dosya duruyor).
console.log("[KuponStore v48] tgo-payment-iframe DISABLED");
