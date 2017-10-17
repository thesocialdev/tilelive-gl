var CPUCount = require("os").cpus().length;
var debug = require("debug")("tilelive-gl");
var fs = require("fs");
var genericPool = require("generic-pool");
var mbgl = require("@mapbox/mapbox-gl-native");
var request = require("request");
var sharp = require("sharp");
var sm = new (require("@mapbox/sphericalmercator"))();

mbgl.on("message", function(e) {
  debug("mbgl: ", e);
  if (e.severity == "WARNING" || e.severity == "ERROR") {
    console.log("mbgl:", e);
  }
});
debug("simd available: " + sharp.simd(true));

module.exports = GL;

function GL(uri, callback) {
  this._uri = uri.pathname;
  this._style = require(uri.pathname);
  this._scale = +uri.query.scale || 1;
  this._tilesize = +uri.query.baseTileSize || 256;
  this._zoomOffset = uri.query.zoomOffset;
  if (uri.query.zoomOffset === undefined) {
    this._zoomOffset = -1;
  } else {
    this._zoomOffset = +uri.query.zoomOffset;
  }

  this._imageOptions = {};
  var imageFormat = uri.query.format || "png";
  if (imageFormat.startsWith("png")) {
    this._mimetype = "image/png";
    this._imageFormat = "png";
    //TODO: add support for png pallete options
  } else if (imageFormat.startsWith("jpeg")) {
    this._mimetype = "image/jpeg";
    this._imageFormat = "jpeg";
  } else if (imageFormat.startsWith("webp")) {
    this._mimetype = "image/webp";
    this._imageFormat = "webp";
  } else {
    throw "Invalid image format";
  }

  if (imageFormat.startsWith("jpeg") || imageFormat.startsWith("webp")) {
    if (imageFormat.endsWith("70")) {
      this._imageOptions["quality"] = 70;
    } else if (imageFormat.endsWith("80")) {
      this._imageOptions["quality"] = 80;
    } else if (imageFormat.endsWith("90")) {
      this._imageOptions["quality"] = 90;
    } else if (imageFormat.endsWith("100")) {
      this._imageOptions["quality"] = 100;
    }
  }

  if (imageFormat.startsWith("png")) {
    this._imageOptions["adaptiveFiltering"] = false;
    this._imageOptions["compressionLevel"] = 6;
  }

  var thisGL = this;
  const factory = {
    create: function() {
      return new Promise(function(resolve, reject) {
        try {
          var map = thisGL._getMap();
          resolve(map);
        } catch (err) {
          console.error("Error creating map:", err);
          reject(err);
        }
      });
    },
    destroy: function(resource) {
      return new Promise(function(resolve) {
        debug(
          "Destroying map for style: " +
            thisGL._uri +
            " used " +
            resource.useCount +
            " times."
        );
        resource.release();
        resolve();
      });
    }
  };

  var maxMapUses = 0;
  if (maxMapUses > 0) {
    factory["validate"] = function(resource) {
      debug("validate");
      return new Promise(function(resolve) {
        console.log("validate: usecount:" + resource.useCount);
        if (resource.useCount != undefined && resource.useCount > maxMapUses) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    };
  }

  var opts = {
    max: 20, // maximum size of the pool
    min: 0, // minimum size of the pool
    testOnBorrow: maxMapUses > 0,
    idleTimeoutMillis: 15 * 60 * 1000,
    evictionRunIntervalMillis: maxMapUses > 0 ? 5 * 60 * 1000 : 0
  };

  debug("Creating pool with opts:", opts);
  this._pool = genericPool.createPool(factory, opts);
  return callback(null, this);
}

GL.prototype._getMap = function() {
  debug("Creating map for style: " + this._uri);
  var _map = new mbgl.Map({
    request: function(req, callback) {
      var start = Date.now();
      var protocol = req.url.split(":")[0];
      if (protocol == "file") {
        var path = req.url.split("://")[1];
        fs.readFile(path, function(err, data) {
          if (err) {
            return callback(err);
          }
          var response = {};
          response.data = data;
          callback(null, response);
          debug("Request for " + req.url + " complete in " + (Date.now() - start) + "ms");
        });
      } else {
        request(
          {
            url: req.url,
            encoding: null,
            gzip: true
          },
          function(err, res, body) {
            var duration = Date.now() - start;
            if(duration > 500) {
              debug("Request for " + req.url + " complete in " + duration + "ms.  Headers:" + JSON.stringify(res.headers));
            } else {
              debug("Request for " + req.url + " complete in " + duration + "ms");
            }
            if (err) {
              callback(err);
            } else if (res.statusCode == 200) {
              var response = {};
              if (res.headers.modified) {
                response.modified = new Date(res.headers.modified);
              }
              if (res.headers.expires) {
                response.expires = new Date(res.headers.expires);
              }
              if (res.headers.etag) {
                response.etag = res.headers.etag;
              }

              response.data = body;

              callback(null, response);
            } else {
              //Dont make rendering fail if a resource is missing
              return callback(null, {});
            }
          }
        );
      }
    },
    ratio: this._scale
  });
  _map.load(this._style);
  return _map;
};

GL.registerProtocols = function(tilelive) {
  tilelive.protocols["gl:"] = GL;
};

GL.prototype.getTile = function(z, x, y, callback) {
  var bbox = sm.bbox(+x, +y, +z, false, "900913");
  var center = sm.inverse([
    bbox[0] + (bbox[2] - bbox[0]) * 0.5,
    bbox[1] + (bbox[3] - bbox[1]) * 0.5
  ]);

  var options = {
    center: center,
    width: this._tilesize,
    height: this._tilesize,
    zoom: z + this._zoomOffset
  };
  this.getStatic(options, callback);
};

GL.prototype.getStatic = function(options, callback) {
  var start = Date.now();
  const mapPromise = this._pool.acquire();
  var thisGL = this;
  mapPromise.then(function(map) {
    debug("Got map in " + (Date.now() - start) + "ms");
    if (map.useCount == undefined) {
      map.useCount = 1;
    } else {
      map.useCount++;
    }
    debug("Map used " + map.useCount + " times.");
    start = Date.now();
    map.render(options, function(err, data) {
      debug("Rendering complete in " + (Date.now() - start) + "ms");
      start = Date.now();
      thisGL._pool.release(map);
      if (err) return callback(err);
      var size = thisGL._tilesize * thisGL._scale;
      var image = sharp(data, {
        raw: {
          width: size,
          height: size,
          channels: 4
        }
      });

      if (thisGL._imageFormat == "png") {
        image = image.png(thisGL._imageOptions);
      } else if (thisGL._imageFormat == "jpeg") {
        image = image.jpeg(thisGL._imageOptions);
      } else {
        image = image.webp(thisGL._imageOptions);
      }
      image.toBuffer(function(err, data, info) {
        debug("Saving image complete in " + (Date.now() - start) + "ms");
        return callback(null, data, { "Content-Type": thisGL._mimetype });
      });
    });
  });
};

GL.prototype.getInfo = function(callback) {
  debug("getInfo for style: " + this._uri);
  var info = {
    minzoom: 0,
    maxzoom: 22
  };
  if (this._style["name"]) {
    info["name"] = this._style["name"];
  }
  if (this._style["center"]) {
    info["center"] = [
      this._style["center"][0],
      this._style["center"][1],
      this._style["zoom"] || 10
    ];
  }
  if (callback) {
    return callback(null, info);
  } else {
    return info;
  }
};
