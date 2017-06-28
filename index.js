var sm = new (require('@mapbox/sphericalmercator'))();
var mbgl = require('mapbox-gl-native');
var sharp = require('sharp');
var request = require('request');
var genericPool = require('generic-pool');
var CPUCount = require('os').cpus().length;

module.exports = GL;

function GL(uri, callback) {
    this._style = require(uri.pathname);
    this._scale = +uri.query.scale || 1;
    this._tilesize = +uri.query.baseTileSize || 256;
    this._zoomOffset = uri.query.zoomOffset;
    if(uri.query.zoomOffset === undefined) {
        this._zoomOffset = -1;
    } else {
        this._zoomOffset = +uri.query.zoomOffset;
    }

    this._imageOptions = {};
    var imageFormat = uri.query.format || "png";
    if(imageFormat.startsWith("png")) {
        this._mimetype = "image/png";
        this._imageFormat = "png";
        //TODO: add support for png pallete options
    } else if(imageFormat.startsWith("jpeg")) {
        this._mimetype = "image/jpeg";
        this._imageFormat = "jpeg";
    } else if(imageFormat.startsWith("webp")) {
        this._mimetype = "image/webp";
        this._imageFormat = "webp";
    } else {
        throw "Invalid image format";
    }

    if(imageFormat.startsWith("jpeg") || imageFormat.startsWith("webp")) {
        if(imageFormat.endsWith("70")) {
            this._imageOptions['quality'] = 70;
        } else if(imageFormat.endsWith("80")) {
            this._imageOptions['quality'] = 80;
        } else if(imageFormat.endsWith("90")) {
            this._imageOptions['quality'] = 90;
        } else if(imageFormat.endsWith("100")) {
            this._imageOptions['quality'] = 100;
        }
    }

    var thisGL = this;
    const factory = {
        create: function(){
            return new Promise(function(resolve, reject) {
                try {
                    var map = thisGL._getMap();
                    resolve(map);
                } catch(err) {
                    reject(err);
                }
            });
        },
        destroy: function(client) {
            return new Promise(function(resolve){
                map.release();
                resolve();
            });
        }
    };

    var opts = {
        max: +uri.query.mapPoolMaxSize || CPUCount, // maximum size of the pool
        min: 0 // minimum size of the pool
    };

    this._pool = genericPool.createPool(factory, opts);
    return callback(null, this);
};

GL.prototype._getMap = function() {
    var _map = new mbgl.Map({
        request: function(req, callback) {
            request({
                url: req.url,
                encoding: null,
                gzip: true
            }, function (err, res, body) {
                if (err) {
                    callback(err);
                } else if (res.statusCode == 200) {
                    var response = {};
                    if (res.headers.modified) { response.modified = new Date(res.headers.modified); }
                    if (res.headers.expires) { response.expires = new Date(res.headers.expires); }
                    if (res.headers.etag) { response.etag = res.headers.etag; }
                    
                    response.data = body;
                    
                    callback(null, response);
                } else {
                    //Dont make rendering fail if a resource is missing
                    return callback(null, {});
                }
            });
        },
        ratio: this._scale
    });
    _map.load(this._style);
    return _map;
};

GL.registerProtocols = function(tilelive) {
    tilelive.protocols['gl:'] = GL;
};

GL.prototype.getTile = function(z, x, y, callback) {
    var bbox = sm.bbox(+x,+y,+z, false, '900913');
    var center = sm.inverse([bbox[0] + ((bbox[2] - bbox[0]) * 0.5), bbox[1] + ((bbox[3] - bbox[1]) * 0.5)]);

    var options = {
        center: center,
        width: this._tilesize,
        height: this._tilesize,
        zoom: z + this._zoomOffset
    };
    this.getStatic(options, callback);
};

GL.prototype.getStatic = function(options, callback) {
    const mapPromise = this._pool.acquire();
    var thisGL = this;
    mapPromise.then(function(map) {
        map.render(options, function(err, data) {
            if (err) return callback(err);
            thisGL._pool.release(map);
            var size = thisGL._tilesize * thisGL._scale;
            var image = sharp(data, {
                raw: {
                    width: size,
                    height: size,
                    channels: 4
                }
            });
            
            if(thisGL._imageFormat == "png") {
                image = image.png(thisGL._imageOptions);
            } else if(thisGL._imageFormat == "jpeg") {
                image = image.jpeg(thisGL._imageOptions);
            } else {
                image = image.webp(thisGL._imageOptions);
            }
            image.toBuffer(function(err, data, info){
                return callback(null, data, { 'Content-Type': thisGL._mimetype });
            });
        });
    });
};

GL.prototype.getInfo = function(callback) {
    var info = {
        minzoom: 0,
        maxzoom: 22
    };
    if(this._style['name']) {
        info['name'] = this._style['name'];
    }
    if(this._style['center']) {
        info['center'] = [this._style['center'][0], this._style['center'][1], this._style['zoom'] || 10];
    }
    if(callback) {
        return callback(null, info);
    } else {
        return info;
    }
};
