module.exports = require('./glue').path;

const origResolve = module.exports.resolve;

module.exports.resolve = function() {
    if (arguments.length === 0) {
        return process.cwd();
    }
    return origResolve.apply(module.exports, arguments);
}