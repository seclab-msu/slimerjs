
if (slimer.hasFeature('coffeescript')) {
    // load the coffee-script module so it can register .coffee extensions
    require('@coffee-script/coffee-script');
}

var fs = require('fs');
const {Cc,Ci,Cr,Cu} = require("chrome");

const system = require('system');

Cu.import('resource://slimerjs/slUtils.jsm');

fs.readFileSync = function(path, encoding) {
    return fs.read(path);
}

fs.writeFileSync = function(path, content) {
    fs.write(path, content, "w");
}

fs.createReadStream = function createReadStream(path) {
    const { Readable } = require('stream');

    const stream = Cc['@mozilla.org/network/file-input-stream;1'].
             createInstance(Ci.nsIFileInputStream);
    const file = fs.MozFile(path);

    try {
      stream.init(file, fs.OPEN_FLAGS.RDONLY, 0, 0);
    }
    catch (err) {
      throw fs.friendlyError(err, path);
    }

    let byteStream = Cc["@mozilla.org/binaryinputstream;1"].
                 createInstance(Ci.nsIBinaryInputStream);
    byteStream.setInputStream(stream);

    return new Readable({
        highWaterMark: 256 * 1024,
        read(size) {
            let shouldContinue = true;

            while(shouldContinue) {
                let buf = new Uint8Array(size);
                const n = byteStream.readArrayBuffer(size, buf.buffer);
                if (n < size) {
                    buf = buf.subarray(0, n);
                }

                if (buf.length === 0) {
                    buf = null;
                }

                shouldContinue = this.push(buf);
            }
        }
    });
};

fs.readFileSyncBinary = function readFileSyncBinary(path) {
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].
             createInstance(Ci.nsIFileInputStream);
    const file = fs.MozFile(path);

    try {
      stream.init(file, fs.OPEN_FLAGS.RDONLY, 0, 0);
    }
    catch (err) {
      throw fs.friendlyError(err, path);
    }

    let byteStream = Cc["@mozilla.org/binaryinputstream;1"].
                 createInstance(Ci.nsIBinaryInputStream);
    byteStream.setInputStream(stream);
    const parts = [];

    while(true) {
        const BUF_SIZE = 20000;

        let buf = new Uint8Array(BUF_SIZE);
        const n = byteStream.readArrayBuffer(BUF_SIZE, buf.buffer);

        if (n < BUF_SIZE) {
            buf = buf.subarray(0, n);
        }

        parts.push(buf);

        if (n < BUF_SIZE) {
            break;
        }
    }
    return Buffer.concat(parts);
}

process.nextTick = (callback, ...args) => {
    setTimeout(() => {
        callback.apply(null, args);
    }, 1);
};
global.Buffer = require("buffer").Buffer;

process.exit = code => {
    slimer.exit(code);
};

process.stdout = system.stdout;
process.stderr = system.stderr;
