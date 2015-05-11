'use strict';

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports'], factory);
  } else if (typeof exports !== 'undefined') {
    factory(exports);
  } else {
    factory((root.astDecoder = {}));
  }
}(this, function (exports) {
  var common = require("./ast-common.js");

  var NamedTable  = common.NamedTable,
      UniqueTable = common.UniqueTable,
      StringTable = common.StringTable,
      ObjectTable = common.ObjectTable;


  function ValueReader (bytes, index, count) {
    this.bytes        = bytes;
    this.byteReader   = encoding.makeByteReader(bytes, index, count);
    this.scratchBytes = new Uint8Array(128);
    this.scratchU32   = new Uint32Array (this.scratchBytes.buffer);
    this.scratchI32   = new Int32Array  (this.scratchBytes.buffer);
    this.scratchF64   = new Float64Array(this.scratchBytes.buffer);
  }

  ValueReader.prototype.readByte = function () {
    return this.byteReader.read();
  };

  ValueReader.prototype.readBytes = function (buffer, offset, count) {
    if (arguments.length === 1) {
      var temp = new Uint8Array(buffer | 0);
      if (this.readBytes(temp, 0, buffer | 0))
        return temp;
      else
        return false;
    }

    for (var i = 0; i < count; i++) {
      var b = this.byteReader.read();

      if (b === false)
        return false;

      buffer[offset + i] = b;
    }

    return true;
  };

  ValueReader.prototype.readScratchBytes = function (count) {
    return this.readBytes(this.scratchBytes, 0, count);
  };

  ValueReader.prototype.readUint32 = function () {
    if (!this.readScratchBytes(4))
      return false;

    return this.scratchU32[0];
  };

  ValueReader.prototype.readInt32 = function () {
    if (!this.readScratchBytes(4))
      return false;

    return this.scratchI32[0];
  };

  ValueReader.prototype.readVarUint32 = function () {
    if (!common.EnableVarints)
      return this.readUint32();

    var result = common.readLEBUint32(this.byteReader);
    return result;
  };

  ValueReader.prototype.readFloat64 = function () {
    if (!this.readScratchBytes(8))
      return false;

    return this.scratchF64[0];
  };

  ValueReader.prototype.readUtf8String = function () {
    var length = this.readVarUint32();
    if (length === false)
      return false;

    if (length === 0)
      return "";

    var result = encoding.UTF8.decode(this.bytes, this.byteReader.getPosition(), length);

    this.byteReader.skip(length);

    return result;
  };

  ValueReader.prototype.skip = function (distance) {
    this.byteReader.skip(distance);
  };


  function JsAstModule (shapes) {
    this.strings = null;
    this.arrays  = null;
    this.objects = null;

    this.shapes  = shapes;

    this.root_id = null;
  };


  function deserializeValue (reader, module) {
    var typeCode = reader.readByte();
    if (typeCode === false)
      throw new Error("Truncated file");

    var typeToken = String.fromCharCode(typeCode);

    switch (typeToken) {
      case "s":
      case "a":
      case "o":
      case "r": {
        var index = reader.readVarUint32();

        switch (typeToken) {
          case "s":
            return module.strings[index];

          case "r":
            var source = module.strings[index];
            var r = new RegExp(source);
            return r;

          case "a":
            return module.arrays[index];

          case "o":
            return module.objects[index];

          default:
            throw new Error("unexpected");            
        }
      }

      case "i":
        return reader.readInt32();

      case "d":
        return reader.readFloat64();

      case "N":
        return null;

      case "T":
        return true;

      case "F":
        return false;

      default:
        throw new Error("Unhandled value type " + typeToken);
    }
  };


  function deserializeArrayContents (reader, module, arr) {
    var count = reader.readVarUint32();

    for (var i = 0; i < count; i++) {
      var value = deserializeValue(reader, module);
      arr[i] = value;
    }
  };


  function deserializeObjectContents (reader, module, obj) {
    var shapeNameIndex = reader.readVarUint32();
    var shapeName = module.strings[shapeNameIndex];
    if (!shapeName)
      throw new Error("Could not look up shape name #" + shapeNameIndex);    
    var shape = module.shapes.get(shapeName);
    if (!shape)
      throw new Error("Could not find shape '" + shapeName + "'");

    obj[module.shapes.shapeKey] = shapeName;

    for (var i = 0, l = shape.fields.length; i < l; i++) {
      var key = shape.fields[i];
      var value = deserializeValue(reader, module);
      obj[key] = value;
    }    
  };


  function deserializeTable (reader, payloadReader) {
    var count = reader.readUint32();
    if (count === false)
      throw new Error("Truncated file");

    var result = new Array(count);

    for (var i = 0; i < count; i++) {
      var item = payloadReader(reader);
      result[i] = item;
    }

    return result;
  };


  function deserializeArrays (reader, module) {
    var count = reader.readUint32();
    if (count === false)
      throw new Error("Truncated file");

    for (var i = 0; i < count; i++) {
      var arr = module.arrays[i];
      deserializeArrayContents(reader, module, arr);
    }    
  };


  function deserializeObjects (reader, module) {
    var count = reader.readUint32();
    if (count === false)
      throw new Error("Truncated file");

    for (var i = 0; i < count; i++) {
      var obj = module.objects[i];
      deserializeObjectContents(reader, module, obj);
    }    
  };


  function bytesToModule (bytes, shapes) {
    var reader = new ValueReader(bytes, 0, bytes.length);

    var magic = reader.readBytes(common.Magic.length);
    if (JSON.stringify(magic) !== JSON.stringify(common.Magic)) {
      console.log(magic, common.Magic);
      throw new Error("Magic header does not match");
    }

    var formatName = reader.readUtf8String();
    if (formatName !== common.FormatName) {
      console.log(formatName, common.FormatName);
      throw new Error("Format name does not match");
    }

    var result = new JsAstModule(shapes);

    result.rootIndex = reader.readUint32();

    // The lengths are stored in front of the tables themselves,
    //  this simplifies table deserialization...
    var stringCount = reader.readUint32();
    var objectCount = reader.readUint32();
    var arrayCount  = reader.readUint32();

    var readUtf8String = function (reader) { 
      var text = reader.readUtf8String();
      if (text === false)
        throw new Error("Truncated file");
      return text;
    };
    var readDehydratedObject = function (reader) { 
      return new Object(); 
    };

    console.time("  read string tables");
    result.strings = deserializeTable(reader, readUtf8String);
    console.timeEnd("  read string tables");

    // Pre-allocate the objects and arrays for given IDs
    //  so that we can reconstruct relationships in one pass.
    result.objects   = new Array(objectCount);
    for (var i = 0; i < objectCount; i++)
      result.objects[i] = new Object();

    result.arrays    = new Array(arrayCount);
    for (var i = 0; i < arrayCount; i++)
      // FIXME: This means we have to grow it when repopulating it. :-(
      result.arrays[i] = new Array();

    console.time("  read objects");
    deserializeObjects(reader, result);
    console.timeEnd("  read objects");

    console.time("  read arrays");
    deserializeArrays (reader, result);
    console.timeEnd("  read arrays");

    return result;
  };


  function moduleToAst (module) {
    return module.objects[module.rootIndex];
  };

  exports.ShapeTable    = common.ShapeTable;
  exports.ValueReader   = ValueReader;
  exports.bytesToModule = bytesToModule;
  exports.moduleToAst   = moduleToAst;
}));