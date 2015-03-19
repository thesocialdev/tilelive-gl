var sm = new (require('sphericalmercator'))();
var fs = require('fs');
var mbgl = require('mapbox-gl-native');

var Pool = require('generic-pool').Pool;
var N_CPUS = require('os').cpus().length;

module.exports = GL;

mbgl.on('message', function(msg) {
    console.log(msg.severity, '[' + msg.class + ']', msg.text);
});

function GL(options, callback) {
    if (typeof options !== 'object' || !options) return callback(new Error('options must be an object'));

    if (!(options.source instanceof mbgl.FileSource)) return callback(new Error('options.source must be a FileSource object'));
    if (typeof options.source.request !== 'function') return callback(new Error("options.source must have a 'request' method"));
    if (typeof options.source.cancel !== 'function') return callback(new Error("options.source must have a 'cancel' method"));

    if (typeof options.style !== 'object') return callback(new Error('options.style must be a GL style object'));
    this._style = options.style;

    this._accessToken = options.accessToken || process.env.MAPBOX_ACCESS_TOKEN;

    this._pool = pool(options.source, this._style, this._accessToken);

    return callback(null, this);
}

function pool(source, style, accessToken) {
    return Pool({
        create: create,
        destroy: destroy,
        max: N_CPUS
    });

    function create(callback) {
        var map = new mbgl.Map(source);
        if (accessToken) map.setAccessToken(accessToken)
        map.load(style);
        return callback(null, map);
    }

    function destroy(map) {
    }
}


GL.prototype.getTile = function(z, x, y, callback) {

    // Hack around tilelive API - allow params to be passed per request
    // as attributes of the callback function.
    var scale = callback.scale || 1;

    var bbox = sm.bbox(+x,+y,+z, false, 'WGS84');
    var bboxCenter = [bbox[1] + ((bbox[3] - bbox[1]) * 0.5), bbox[0] + ((bbox[2] - bbox[0]) * 0.5)];

    console.log(bbox);
    console.log(bboxCenter);

    var mbox = sm.bbox(+x,+y,+z, false, '900913');
    var mercatorCenter = [mbox[1] + ((mbox[3] - mbox[1]) * 0.5), mbox[0] + ((mbox[2] - mbox[0]) * 0.5)];
    var center = sm.inverse(mercatorCenter);

    console.log(center);

    var options = {
        center: center,
        width: 512,
        height: 512,
        ratio: scale || 1,
        zoom: z
    };

    this._pool.acquire(function(err, map) {
        if (err) return callback(err);

        map.render(options, function(err, buffer) {
            if (err) return callback(err);
            mbgl.compressPNG(buffer, function(err, image) {
                if (err) return callback(err);
                this._pool.release(map);
                return callback(null, image, { 'Content-Type': 'image/png' });
            }.bind(this));
        }.bind(this));
    }.bind(this));
};
