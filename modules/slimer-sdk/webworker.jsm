var EXPORTED_SYMBOLS = ["Worker"];

function Worker(url, options) {
    return new ChromeWorker(url, options);
}