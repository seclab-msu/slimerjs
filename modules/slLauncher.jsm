/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
"use strict";
var EXPORTED_SYMBOLS = ["slLauncher"];

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import('resource://slimerjs/addon-sdk/toolkit/loader.js'); //Sandbox, Require, main, Module, Loader
Cu.import('resource://slimerjs/slConsole.jsm');
Cu.import('resource://slimerjs/slUtils.jsm');
Cu.import('resource://slimerjs/slConfiguration.jsm');

const windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"]
                     .getService(Ci.nsIWindowMediator);

const fileHandler = Cc["@mozilla.org/network/protocol;1?name=file"]
                     .getService(Ci.nsIFileProtocolHandler)
const systemPrincipal = Cc['@mozilla.org/systemprincipal;1']
                        .createInstance(Ci.nsIPrincipal)
const appInfo = Cc["@mozilla.org/xre/app-info;1"]
                .getService(Ci.nsIXULAppInfo);
const versionComparator = Cc["@mozilla.org/xpcom/version-comparator;1"]
                          .getService(Ci.nsIVersionComparator);

// to avoid Reference Error when running long time Script. Fx52. see issue #590
let debugService = Cc["@mozilla.org/dom/slow-script-debug;1"]
    .getService(Ci.nsISlowScriptDebug);
debugService.activationHandler = null;

/**
 * this function retrieves various informations
 * about the main script. These informations will
 * be used to create the corresponding module
 * and the module loader
 * @return object
 */
function getMainScriptInfo() {
    let scriptURI = slConfiguration.mainScriptURI.QueryInterface(Ci.nsIURL);

    let scriptInfo = {
        isFile: true,
        id: 'main',
        URI: scriptURI.spec,
        dirURI: scriptURI.scheme+'://'+scriptURI.host+scriptURI.directory,
        requirePath : null,
        modulePathAlias: '',
    };

    let scheme = scriptURI.scheme;
    if (scheme == 'file') {
        scriptInfo.requirePath = slConfiguration.scriptFile.parent;
    }
    else if (scheme == 'chrome' || scheme == 'resource') {
        scriptInfo.modulePathAlias = slConfiguration.scriptModulePath;
        scriptInfo.id = scriptInfo.modulePathAlias+scriptURI.fileBaseName;
        scriptInfo.isFile = false;
    }
    else {
        throw new Error('Script URI: unsupported protocol ('+scheme+')');
    }
    return scriptInfo;
}

/**
 * The module loader
 */
var mainLoader = null;

/**
 * the HTML window that serves as prototype
 * for the sandbox where the main script
 * is injected
 */
var mainWindow = null;

/**
 * the sandbox for the CoffeScript compiler
 */
var coffeeScriptSandbox = null;

/**
 * the public interface of slLauncher
 */
var slLauncher = {
    launchMainScript: function (contentWindow) {
        mainWindow = contentWindow;

        let principal = contentWindow.document.nodePrincipal;
        if (geckoMajorVersion > 20 && geckoMajorVersion < 50) {
            // autorize the main script to use navigator.mozTCPSocket  https://developer.mozilla.org/en-US/docs/WebAPI/TCP_Socket
            Services.perms.addFromPrincipal(principal, "tcp-socket", Ci.nsIPermissionManager.ALLOW_ACTION);
            // FIXME: do other authorization: video, audio, geoloc...?
        }

        if (slConfiguration.enableCoffeeScript) {
            // prepare the sandbox to execute coffee script injected with injectJs
            coffeeScriptSandbox = Cu.Sandbox(contentWindow,
                                {
                                    sandboxName: 'coffeescript',
                                    // Firefox 40.0 and above handles sandboxPrototype different then before
                                    sandboxPrototype: versionComparator.compare(appInfo.platformVersion, '40') < 0 ? {} : contentWindow,
                                    wantXrays: true
                                });
            let src = slUtils.readChromeFile("resource://slimerjs/coffee-script/extras/coffee-script.js");
            Cu.evalInSandbox('var CoffeeScript;', coffeeScriptSandbox, 'ECMAv5', 'slLauncher::launchMainScript', 1);
            Cu.evalInSandbox(src, coffeeScriptSandbox, 'ECMAv5', 'coffee-scripts.js', 1);
        }

        // prepare the environment where the main script will be executed in
        // and prepare the loader which will load all other modules
        let scriptInfo = getMainScriptInfo();
        mainLoader = prepareLoader(scriptInfo);

        try {
            // first load the bootstrap module
            let bsModule = Loader.Module('@slimer-sdk/bootstrap', 'resource://slimerjs/slimer-sdk/bootstrap.js');
            mainLoader.load(mainLoader, bsModule);

            // load the main module
            let uri = scriptInfo.sURI;
            let module = mainLoader.main
                       = mainLoader.modules[scriptInfo.URI]
                       = Loader.Module(scriptInfo.id, scriptInfo.URI);

            mainLoader.load(mainLoader, module);
        }
        catch(e) {
            this.showError(e, slConfiguration.mainScriptURI);
        }
    },

    injectJs : function (source, uri) {
        let isCoffeeScript = uri.endsWith(".coffee");

        if (source.startsWith("#!") && !isCoffeeScript) {
            source = "//" + source;
        }

        if (isCoffeeScript) {
            if (!coffeeScriptSandbox) {
                throw new Error ("Sorry, CoffeeScript is disabled");
            }
            coffeeScriptSandbox.source = source
            let src = "this.CoffeeScript.compile(this.source);";
            source = Cu.evalInSandbox(src, coffeeScriptSandbox, 'ECMAv5', 'slLauncher::injectJs', 1);
        }

        let sandbox = mainLoader.sandboxes[mainLoader.main.uri];

        let evalOptions =  {
          version : mainLoader.javascriptVersion,
          source: source
        }
        Loader.evaluate(sandbox, uri, evalOptions);
        return true;
    },

    showError : function(e, fileURI) {
        if (('name' in e && e.name == 'FatalError') || !this.errorHandler)
            throw e;
        let [msg, stackRes] = getTraceException(e, fileURI);
        this.errorHandler(msg, stackRes);
    },

    // can be changed by the phantom module
    errorHandler : function(msg, stack) {
        this.defaultErrorHandler(msg, stack)
    },

    defaultErrorHandler : function (msg, stack) {
        dump("\nScript Error: "+msg+"\n");
        if (stack && stack.length) {
            dump("       Stack:\n");
            stack.forEach(function(t) {
                dump('         -> ' + (t.file || t.sourceURL) + ': ' + t.line + (t.function ? ' (in function ' + t.function + ')' : '')+"\n");
            })
            dump("\n");
        }
    },

    /**
     * create a new browser element. call the given callback when it is ready,
     * with the XUL browser element as parameter.
     */
    openBrowser : function(callback, parentWindow, size) {
        if (!parentWindow)
            parentWindow = windowMediator.getMostRecentWindow("slimerjs");
        let features = "chrome,dialog=no,scrollbars=no";
        if (size) {
            features += ",width="+size.width+",height="+size.height;
        }
        return parentWindow.openDialog("chrome://slimerjs/content/webpage.xul", "_blank", features, { callback:callback});
    },

    closeBrowser: function (browser) {
        let win = browser.ownerDocument.defaultView.top;
        win.close();
    }
}

/**
 * @param string filename
 * @param base nsIFile
 */
function isFile(filename, base) {
    try {
        let file;
        if (base) {
            file = slUtils.getAbsMozFile(filename, base);
        }
        else {
            file = slUtils.getMozFile(filename);
        }

        if (file.exists()) {
            return file;
        }
    }
    catch(e){
    }
    return false;
}

function fillDescriptor(object, host) {
    Object.getOwnPropertyNames(object).forEach(function(name) {
        host[name] = Object.getOwnPropertyDescriptor(object, name)
    });
}

const nativeModules = {
    'fs' : '@addons-sdk/sdk/io/file',
    'webpage': '@slimer-sdk/webpage',
    'net-log' : '@slimer-sdk/net-log',
    'webserver' : 'webserver',
    'webworker': 'webworker',
    'system' : '@slimer-sdk/system',
    'chrome': 'chrome',
    'vm':'@slimer-sdk/vm',
    'nodejs-environment-startup': '@slimer-sdk/nodejs-environment-startup',

    'path':'@slimer-sdk/node-glue/path',
    'util':'@slimer-sdk/node-glue/util',
    'tty':'@slimer-sdk/node-glue/tty',
    'jsesc':'@slimer-sdk/node-glue/jsesc',
    'debug':'@slimer-sdk/node-glue/debug',
    'os':'@slimer-sdk/node-glue/os',
    'events':'@slimer-sdk/node-glue/events',
    'assert':'@slimer-sdk/node-glue/assert',
    'stream':'@slimer-sdk/node-glue/stream',
    'constants':'@slimer-sdk/node-glue/constants',
    'buffer': '@slimer-sdk/node-glue/buffer',
};

const nativeMapping = {
    '@addons-sdk/': 'resource://slimerjs/addon-sdk/',
    '@slimer-sdk/': 'resource://slimerjs/slimer-sdk/',
    '@loader/': 'resource://slimerjs/@loader',
    '@analyzer': 'resource://analyzer',
    'chrome': 'resource://slimerjs/@chrome',
    'webserver' : 'resource://slimerjs/slimer-sdk/webserver.jsm',
    'webworker': 'resource://slimerjs/slimer-sdk/webworker.jsm'
}

const firstPathPart = /^([a-zA-Z\-]+\/)/;

/**
 * prepare the module loader
 * Some things here could be done in the loader.js file, but we want to avoid to
 * modify it because this is an external file.
 * @param object scriptInfo  given by getMainScriptInfo()
 */
function prepareLoader(scriptInfo) {

    var loader;

    var metadata ={
        permissions : {}
    };

    // it will contain all paths of require.paths
    var requirePaths = new Array();

    let pathsMapping = { }
    pathsMapping[scriptInfo.id] = scriptInfo.URI;

    for(let i in nativeMapping) {
        pathsMapping[i] = nativeMapping[i];
    }

    if (slConfiguration.enableCoffeeScript) {
        pathsMapping['@coffee-script/'] = 'resource://slimerjs/coffee-script/lib/coffee-script/';
    }

    if (!scriptInfo.isFile) {
        // the main script is an internal script
        pathsMapping[scriptInfo.modulePathAlias] = scriptInfo.dirURI;
    }

    // path where to search each time require() is called. Filled during resolution of the module name
    var additionalPaths = [];

    // list of extensions and their compiler
    var extensions = {
        '.js': function(module, filename) {
            let content = slUtils.readSyncStringFromFile(slUtils.getMozFile(filename));
            return module._compile(content, filename);
        },
        '.json': function(module, filename) {
            let content = slUtils.readSyncStringFromFile(slUtils.getMozFile(filename));
            module.exports = JSON.parse(content);
        }
    }

    function tryResolveModule(id, baseFile) {
        let moduleMain = 'index.js';

        const packageJSONFile = slUtils.getAbsMozFile('package.json', baseFile);

        if (packageJSONFile.exists()) {
            const packageJSON = slUtils.readSyncStringFromFile(packageJSONFile);
            const packageConfig = JSON.parse(packageJSON);
            moduleMain = packageConfig.main || moduleMain;
        }

        let f = isFile(moduleMain,  baseFile);

        if (f && f.isFile()) {
            return f;
        }

        f = isFile(moduleMain + '/index.js',  baseFile);

        if (f && f.isFile()) {
            return f;
        }

        for(let ext in extensions) {
            f = isFile(moduleMain+ext, baseFile);
            if (f)
                return f;
        }

        return null;
    }

    function findFileExtension(id, baseFile) {
        let f;

        for(let ext in extensions) {
            f = isFile(id+ext, baseFile);
            if (f) {
                return f;
            }
        }

        f = isFile(id, baseFile)
        let isDir = false;
        if (f) {
            if (f.isDirectory()) {
                isDir = true;
                baseFile = f;
            }
            else {
                return f;
            }
        }

        if (isDir && baseFile) {
            f = tryResolveModule(id, baseFile);
            if (f) {
                return f;
            }
        }
        return null;
    }

    // will contain all global objects/function/variable accessible from all
    // modules.
    var globalProperties = { },
        sharedSandbox = null;

    loader =  Loader.Loader({
        javascriptVersion : 'ECMAv5',
        id:'slimerjs@innophi.com',
        name: 'SlimerJs',
        rootURI: scriptInfo.dirURI,
        // metadata: needed by some modules of the addons sdk
        metadata: Object.freeze(metadata),
        paths:pathsMapping,
        globals: {
            console: new slConsole()
        },
        modules: {
          "webserver": Cu.import("resource://slimerjs/slimer-sdk/webserver.jsm", {}),
          "webworker": Cu.import("resource://slimerjs/slimer-sdk/webworker.jsm", {})
        },
        // this function should return the true id of the module.
        // The returned id should be an id or an absolute path of a file
        resolve: function(id, requirer) {
            additionalPaths = [];
            let relativeId = false;
            if (id[0] == '.') {
                relativeId = id;
                id = Loader.resolve(id, requirer);
            }

            if (id in nativeModules && !relativeId)
                return nativeModules[id];

            if (id.indexOf('@loader/') === 0) {
                if (requirer.id[0] == '@') {
                    return id;
                }

                throw new Error("Unknown "+ id +" module");
            }

            if (id.startsWith('sdk/')) {
                return '@addons-sdk/'+id;
            }

            if (id.startsWith('analyzer/')) {
                return '@'+id;
            }

            // if this is a slimerjs module, don't try to find it in module paths
            if (id[0] == '@' && !id.startsWith('@babel') && !id.startsWith('@jridgewell')) {
                return id;
            }
            if (relativeId === false && slUtils.isAbsolutePath(id)) {
                // id is an absolute path
                additionalPaths.push(id);
                return id;
            }

            let requirerUri = Services.io.newURI(requirer.uri, null, null);
            let requirerDir = requirerUri.QueryInterface(Ci.nsIFileURL).file.parent;

            if (relativeId !== false) {
                // id is a relative path
                additionalPaths.push(requirerDir);
            }
            else if (requirerDir) {
                // let's add node_modules directories
                let dir = requirerDir;
                while(dir) {
                    let d = dir.clone();
                    d.append('node_modules');
                    additionalPaths.push(d);
                    dir = dir.parent;
                }
            }

            additionalPaths.push(scriptInfo.requirePath);

            // id is not an absolute path or relative path (ex: foo or foo/bar)
            // let's add all path of requirePaths to search inside them
            for (let i=0; i < requirePaths.length;i++) {
                // if path is a relative path, it should be
                // resolve against the current module path;
                let path = requirePaths[i];
                let dir;
                if (path[0] == '.' || !slUtils.isAbsolutePath(path)) {
                    additionalPaths.push(slUtils.getAbsMozFile(path, requirerDir));
                }
                else {
                    additionalPaths.push(slUtils.getMozFile(path));
                }
            }
            if (relativeId) {
                return relativeId;
            }
            return id;
        },

        resolveURI : function(id, mapping) {
            let uri = Loader.resolveURI(id, mapping);
            if (uri) {
                return uri;
            }

            for(let i=0; i < additionalPaths.length; i++) {
                let path = additionalPaths[i];
                if (typeof path == 'string') {
                    if (id === path) {
                        // id is an absolute path
                        let f = findFileExtension(id);
                        if (f) {
                            return Services.io.newFileURI(f).spec;
                        }
                        // since id is an absolute path, we should not try other path
                        return null;
                    }
                    path = slUtils.getMozFile(path);
                }

                let file = findFileExtension(id, path);
                if (file) {
                    return Services.io.newFileURI(file).spec;
                }
            }

            return null;
        },
        // It loads the given module into a sandbox.
        // It replaces the default loader, Loader.load
        load : function(loader, module) {

            // let's prepare the require function that will
            // be available in the sandbox.
            const requirer = {
                id: module.id,
                uri: module.uri,
                url: module.url,
                toString() {
                    return 'module: ' + module.id + ' | ' + module.uri
                }
            };
            var require = Loader.Require(loader, requirer);

            require.requirer = requirer;

            Object.defineProperty(require, 'paths',
                                  {
                                    enumerable:true,
                                    value: requirePaths,
                                    writable:false,
                                  });
            Object.defineProperty(require, 'globals',
                                  {
                                    enumerable:true,
                                    value: globalProperties,
                                    writable:false,
                                  });
            Object.defineProperty(require, 'extensions',
                                  {
                                    enumerable:true,
                                    value: extensions,
                                    writable:false,
                                  });

            // let's create the sandbox
            let sandbox;
            if (sharedSandbox === null) {
                sandbox = Loader.Sandbox({
                    principal: systemPrincipal,
                    name: module.uri,
                    prototype:mainWindow,
                    wantXrays: true
                });

                // let's define some object available in the sandbox
                Cu.import('resource://slimerjs/slimer-sdk/slimer.jsm', sandbox);
                Cu.import('resource://slimerjs/slimer-sdk/phantom.jsm', sandbox);
                Cu.import('resource://slimerjs/slimer-sdk/process.jsm', sandbox);

                let properties = {};
                fillDescriptor(globalProperties, properties)
                fillDescriptor(loader.globals, properties)
                Object.defineProperties(sandbox, properties);
            }


            if (sharedSandbox === null) {
                sharedSandbox = sandbox;
            } else {
                sandbox = sharedSandbox;
            }

            sandbox.require = require;
            sandbox.module = module;
            sandbox.exports = module.exports;
            // XXX: some modules will have empty __filename and __dirname
            sandbox.__filename = '';
            sandbox.__dirname = '';

            // this method is called by extension handlers
            // @see require.extensions, and the extensions var
            module._compile = function (content, filename) {
                if (content.startsWith('#')) {
                    content = '//'+content;
                }
                // XXX: this makes main module be wrapped in a function
                // this may have unforeseen consequences
                //if (this != mainLoader.main) {
                    content = '(function(require, exports, module, __filename, __dirname){'+
                        '(function(){const global=this;this.global=this;const globalThis=this;this.globalThis=globalThis;})();'+
                        content+'\n}).call({},require, module.exports, module, __filename, __dirname);\n';
                // }
                Loader.load(loader, module, sandbox, content);
            }

            // for modules that are provided as JSM modules,
            // load them with Loader
            // we assume that it is always a javascript script
            if (module.uri.indexOf('file://') == -1) {
                // XXX: this makes all modules with .js extension be wrapped in a function
                // this may have unforeseen consequences
                if (module.uri.endsWith('.js')) {
                    let content = slUtils.readChromeFile(module.uri);
                    module._compile(content, module.uri);
                }
                else {
                    Loader.load(loader, module, sandbox);
                }
                return;
            }

            // the module is an external file
            let file;
            try {
                file = fileHandler.getFileFromURLSpec(module.uri);
            }
            catch(e) {
                dump("err for "+module.uri+": "+e+"\n")
                throw e;
            }

            sandbox.__filename = file.path;
            sandbox.__dirname = file.parent.path;
            let filename = file.leafName;
            let source = '';
            // depending of the extension of the module file,
            // we load the module with the corresponding handler
            let hasBeenLoaded = false;
            for(let ext in extensions) {
                let idx = filename.lastIndexOf(ext);
                if (idx == -1 || idx != (filename.length - ext.length)) {
                    continue;
                }
                extensions[ext](module, file.path);
                hasBeenLoaded = true;
                break;
            }
            if (!hasBeenLoaded) {
                let err = new Error(file.path + " is not a supported type file")
                if (module.id == "main") {
                    err.name = 'FatalError';
                }
                throw err;
            }
        }
    });

    return loader;
}
