var EXPORTED_SYMBOLS = ["process"];

Components.utils.import('resource://slimerjs/slConfiguration.jsm');
Components.utils.import('resource://slimerjs/slUtils.jsm');

var envService = Components.classes["@mozilla.org/process/environment;1"].
          getService(Components.interfaces.nsIEnvironment);
var environment;

// we use a Proxy object to access to environment variable
// so we can get and set any environment variable, even those which don't exist yet
var environmentHandler = {
    has : function (obj, prop) {
        return envService.exists(prop);
    },
    get : function (obj, prop) {
        if (envService.exists(prop))
            return envService.get(prop);
        return "";
    },
    set : function (obj, prop, value) {
        if (!envService.exists(prop))
            slConfiguration.envs.push(prop);
        return envService.set(prop, value);
    },
    ownKeys : function(obj) {
        return slConfiguration.envs;
    },
    getOwnPropertyDescriptor: function(target, prop) {
        if (!envService.exists(prop))
            return undefined;
        return {
            value: envService.get(prop),
            enumerable: true,
            configurable: true,
            writable: true
        }
    },
    defineProperty: function(prop, { value }){
        if (!envService.exists(prop)) {
            slConfiguration.envs.push(prop);
        }
        envService.set(prop, value);
    },


    // obsolete properties since Firefox 33

    hasOwn : function (obj, prop) {
        return envService.exists(prop);
    },
    getOwnPropertyNames : function(obj) {
        return slConfiguration.envs;
    },
    keys : function(obj) {
        return slConfiguration.envs;
    },

    // obsolete? Not defined in Proxy spec
    getPropertyDescriptor: function(prop) {
        return this.getOwnPropertyDescriptor(prop)
    },
    getPropertyNames : function(obj) {
        return slConfiguration.envs;
    },
    enumerate : function(obj) {
        return slConfiguration.envs;
    },
    iterate : function(obj) {
        var props = slConfiguration.envs, i = 0;
        return {
            next: function() {
            if (i === props.length) throw StopIteration;
                return props[i++];
            }
        };
    },

}
environment = new Proxy({}, environmentHandler);

var process =  {
    get env() {
        return environment;
    },
    get argv() {
        return slConfiguration.args;
    },
    cwd() {
        return slUtils.workingDirectory.path;
    },
    on() {}, // TODO: improve
    removeListener() {}, // TODO: improve
    __exposedProps__ : {
        env : 'r',
        exit : 'r',
        argv: 'r'
    }
};
