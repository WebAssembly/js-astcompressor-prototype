'use strict';

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports'], factory);
  } else if (typeof exports !== 'undefined') {
    factory(exports);
  } else {
    factory((root.astEncoder = {}));
  }
}(this, function (exports) {
  var common        = require("./ast-common.js");
  var Configuration = require("./configuration.js");
  var treeBuilder   = require("./parse/treebuilder.js");

  var AsmlikeJsonTreeBuilder = treeBuilder.AsmlikeJSON;  
  var NamedTable   = common.NamedTable,
      UniqueTable  = common.UniqueTable,
      StringTable  = common.StringTable,
      ObjectTable  = common.ObjectTable,
      GetObjectId  = common.GetObjectId,
      NextObjectId = common.NextObjectId;

  var IoTrace = false;
  var TraceInlining = false;
  var TraceInlinedTypeCount = 0;

  function ValueWriter (configuration, description, parent) {
    // HACK: Default max size 128mb because growable buffers are effort
    var capacity = (1024 * 1024) * 128;
    if (parent)
      capacity /= 4;

    this.bytes    = new Uint8Array(capacity);
    this.position = 0;
    this.view     = new DataView(this.bytes.buffer);

    if (parent)
      this.varintSizes = parent.varintSizes;
    else
      this.varintSizes = [0, 0, 0, 0, 0];

    if (!configuration)
      throw new Error("configuration required");

    this.configuration = configuration;
    this.description   = description;
  };

  ValueWriter.prototype.getPosition = function () {
    return this.position;
  };

  ValueWriter.prototype.skip = function (distance) {
    this.position += distance;
  };

  ValueWriter.prototype.write = 
  ValueWriter.prototype.writeByte = function (b) {
    if (this.position >= this.bytes.length)
      throw new Error("buffer full");

    if (IoTrace)
      console.log(this.description + " write byte", b.toString(16));

    this.bytes[this.position++] = b;
  };

  ValueWriter.prototype.writeBytes = function (bytes, offset, count) {
    if (this.position >= this.bytes.length)
      throw new Error("buffer full");

    if (arguments.length === 1) {
      this.bytes.set(bytes, this.position);
      this.position += bytes.length;
      return;
    } else if (arguments.length === 3) {
      offset |= 0;
      count |= 0;
    } else {
      throw new Error("Expected (bytes) or (bytes, offset, count)");
    }

    this.bytes.set(bytes.subarray(offset, offset + count), this.position);
    this.position += count;
  };

  ValueWriter.prototype.writeScratchBytes = function (count) {
    this.writeBytes(this.scratchBytes, 0, count);
  };

  ValueWriter.prototype.writeUint24 = function (value) {
    var masked = value & 0xFFFFFF;
    if (masked !== value)
      throw new Error("Value is larger than 24 bits");

    if (IoTrace)
      console.log(this.description + " write uint24", masked.toString(16));

    this.view.setUint32(this.position, masked, true);
    this.position += 3;
  };

  ValueWriter.prototype.writeUint32 = function (value) {
    this.view.setUint32(this.position, value, true);

    if (IoTrace)
      console.log(this.description + " write uint", value.toString(16), 
        "[" + this.bytes[this.position].toString(16) + " " + this.bytes[this.position + 1].toString(16) + " " + this.bytes[this.position + 2].toString(16) + "]"
      );

    this.position += 4;
  };

  ValueWriter.prototype.writeInt32 = function (value) {
    if (IoTrace)
      console.log(this.description + " write int", value.toString(16));

    this.view.setInt32(this.position, value, true);
    this.position += 4;
  };

  ValueWriter.prototype.writeVarUint32 = function (value) {
    if (this.configuration.EnableVarints) {
      if (IoTrace)
        console.log(this.description + " write varuint", value.toString(16));

      var before = this.position;
      common.writeLEBUint32(this, value);
      var after = this.position;
      var lengthBytes = after - before;
      this.varintSizes[lengthBytes - 1] += 1;

      // HACK for checking inlining markers
      return this.bytes[before];
    } else if (this.configuration.ThreeByteIndices) {
      this.writeUint24(value);
    } else {
      this.writeUint32(value);
    }
  };

  ValueWriter.prototype.writeVarInt32 = function (value) {
    if (this.configuration.EnableVarints) {
      if (IoTrace)
        console.log(this.description + " write varint", value.toString(16));

      var before = this.position;
      common.writeLEBInt32(this, value);
      var after = this.position;
      var lengthBytes = after - before;
      this.varintSizes[lengthBytes - 1] += 1;

      // HACK for checking inlining markers
      return this.bytes[before];
    } else {
      this.writeInt32(value);
    }
  };

  ValueWriter.prototype.writeIndex = function (value) {
    if (typeof (value) !== "number") {
      if (
        (typeof (value) === "object") && 
        value &&
        (value.type === "symbol")
      )
        value = value.valueOf();
      else
        throw new Error("writeIndex expected number");
    }

    if (value === 0xFFFFFFFF)
      this.writeVarUint32(0);
    else
      this.writeVarUint32(value + 1);
  };

  ValueWriter.prototype.writeFloat64 = function (value) {
    if (IoTrace)
      console.log(this.description + " write float64", value.toFixed(4));

    this.view.setFloat64(this.position, value, true);
    this.position += 8;
  };

  ValueWriter.prototype.writeUtf8String = function (text) {
    // HACK so we can encode null strings as distinct from ""
    if (text === null) {
      if (this.configuration.NullTerminatedStrings)
        this.writeByte(0xFF);
      else
        this.writeIndex(0xFFFFFFFF);

      return;
    }

    if (typeof (text) !== "string")
      throw new Error("writeUtf8String expected string");

    var lengthBytes = 0;
    var counter = {
      write: function (byte) {
        lengthBytes += 1;
      },
      getResult: function () {
      }
    };

    // Encode but discard bytes to compute length
    encoding.UTF8.encode(text, counter);

    if (!this.configuration.NullTerminatedStrings)
      this.writeIndex(lengthBytes);

    encoding.UTF8.encode(text, this);

    if (this.configuration.NullTerminatedStrings)
      this.writeByte(0);
  };

  ValueWriter.prototype.writeSubstream = function (otherWriter) {
    var sizeBytes = otherWriter.position;
    var description = otherWriter.description;

    if (common.LogStreamSizes && (sizeBytes >= 8 * 1024))
      console.log(description + ": " + (sizeBytes / 1024).toFixed(2) + "KB");

    var prior = IoTrace;
    IoTrace = false;

    this.writeUtf8String(description);
    this.writeUint32(sizeBytes);

    this.writeBytes(otherWriter.bytes, 0, sizeBytes);

    this.writeUint32(sizeBytes);

    IoTrace = prior;
  };

  ValueWriter.prototype.getResult = 
  ValueWriter.prototype.toArray = function () {
    return this.bytes.subarray(0, this.position);
  };


  function JsAstModule (configuration, shapes) {
    this.configuration = configuration;
    this.shapes        = shapes;

    // Used to store the inferred type tags for arrays during
    //  the initial tree-walk
    this.arrayTypeTags     = new WeakMap();
    // Used to cache the result of the 'shape small enough to always inline' check
    this.isShapeSmallCache = new WeakMap();

    this.tags    = new StringTable("tag");

    this.tags.add("any");
    this.tags.add("array");
    this.tags.add("object");
    this.tags.add("boolean");
    this.tags.add("string");
    this.tags.add("symbol");
    this.tags.add("integer");
    this.tags.add("number");

    this.objects = new ObjectTable("object");
    this.valueStreams = Object.create(null);

    this.inliningWriter    = null;
    this.typeTagWriter     = null;
    this.packedIndexWriter = null;

    this.anyTypeValuesWritten = 0;
    this.typeTagsWritten = 0;
    this.inlinedObjects = 0;
    this.notInlinedObjects = 0;

    this._getTableForTypeTag = this.getTableForTypeTag.bind(this);
  };


  JsAstModule.prototype.isShapeSmall = function (shape) {
    if (typeof (this.configuration.InlineObjectSizeThreshold) !== "number")
      return false;

    var result = this.isShapeSmallCache.get(shape);
    if (typeof (result) === "boolean")
      return result;

    var estimatedIndexSize = 
      this.configuration.EnableVarints
        ? 3 // FIXME: 2?
        : 4;

    // Type tag
    var size = estimatedIndexSize;
    // Inlining flag
    if (this.configuration.ConditionalInlining)
      size += 1;

    for (var i = 0, l = shape.shape.fields.length; i < l; i++) {
      var fd = shape.shape.fields[i];

      switch (fd.type) {
        case "integer":
          size += 4;
          break;

        case "double":
          size += 8;
          break;

        case "boolean":
          size += 1;
          break;

        default:
          size += estimatedIndexSize;
          break;
      }
    }

    result = (size <= this.configuration.InlineObjectSizeThreshold);
    this.isShapeSmallCache.set(shape, result);
    return result;
  };


  JsAstModule.prototype.getObjectTable = function (nodeOrShape) {
    if (nodeOrShape === null)
      return null;

    return this.objects;
  };


  JsAstModule.prototype.getShapeForObject = function (obj) {
    var shapeName = obj[this.shapes.shapeKey];

    if (typeof (shapeName) !== "string") {
      // HACK so js RegExp instances can fit into this shape model
      if (
        (typeof (obj) === "object") &&
        (Object.getPrototypeOf(obj) === RegExp.prototype)
      )
        shapeName = "RegExp";
      else
        throw new Error("Unsupported object " + obj + " with shape name " + JSON.stringify(shapeName))
    }

    var shape = this.shapes.get(shapeName);
    if (!shape) {
      console.log(shapeName, obj, Object.getPrototypeOf(obj), obj.toString());
      throw new Error("Unknown shape " + shapeName);
    }

    var shapeTagIndex = null;
    if (this.tags.isFinalized) {
      shapeTagIndex = this.tags.get_index(shapeName);
    } else {
      this.tags.add(shapeName);
    }

    return {
      name: shapeName,
      shape: shape,
      tagIndex: shapeTagIndex
    };
  };


  JsAstModule.prototype.createValueStreams = function (writer) {
    var self = this;

    this.tags.forEach(function (entry) {
      var tag = entry.get_name();

      self.valueStreams[tag] = new ValueWriter(self.configuration, "values[" + tag + "]", writer);
    });
  };


  JsAstModule.prototype.getValueWriterForField = function (defaultWriter, field, tag) {
    if (this.configuration.ValueStreamPerType) {
      var writer = this.valueStreams[tag];
      if (!writer)
        throw new Error("No value stream for tag '" + tag + "'");

      return writer;
    } else {
      return defaultWriter;
    }
  };


  JsAstModule.prototype.writeTypeTag = function (defaultWriter, tag) {
    var writer = defaultWriter;
    if (this.configuration.TypeTagStream)
      writer = this.typeTagWriter;

    writer.writeIndex(tag);

    this.typeTagsWritten += 1;
  };


  JsAstModule.prototype._writeInliningFlag = function (flag) {
    this.inliningWriter.writeByte(flag);
  };


  JsAstModule.prototype._writePackedIndex = function (writer, flag, index) {
    if (this.configuration.PackedIndexStream)
      writer = this.packedIndexWriter;

    if ((flag === 0xFF) || (index === 0xFFFFFFFF)) {
      // console.log("packed", flag, index, "-> FFFFFFFF");
      // LEB 0xFFFFFFFF == 0
      writer.writeIndex(0xFFFFFFFF);
      return;
    }

    var packed = index << 1;
    packed |= (flag & 0x1);

    // console.log("packed", flag, index, "->", packed.toString(16));
    writer.writeIndex(packed);
  };


  JsAstModule.prototype.writeInliningFlagAndIndex = function (writer, flag, index) {
    if (this.configuration.PackedInliningFlags) {
      this._writePackedIndex(writer, flag, index);
    } else {
      this._writeInliningFlag(flag);
      if (flag === 0xFF)
        return;

      writer.writeIndex(index);
    }
  };


  JsAstModule.prototype.writeInliningFlagAndTypeTag = function (writer, flag, typeTag) {
    if (this.configuration.PackedInliningFlags) {
      this._writePackedIndex(writer, flag, typeTag);
      this.typeTagsWritten += 1;
    } else {
      this._writeInliningFlag(flag);
      if (flag === 0xFF)
        return;

      this.writeTypeTag(writer, typeTag);
    }
  };


  JsAstModule.prototype.serializeFieldValue = function (writer, shape, field, value, overrideWriter) {
    // FIXME: Hack together field definition type -> tag conversion
    var tag = common.pickTagForField(field, this._getTableForTypeTag);

    if (
      overrideWriter &&
      this.configuration.NoOverridingPrimitiveStream &&
      common.TagIsPrimitive[tag]
    )
      overrideWriter = false;

    try {
      if (!overrideWriter) {
        var oldWriter = writer;
        writer = this.getValueWriterForField(writer, field, tag);

        if (IoTrace) {
          if (writer === oldWriter)
            console.log("field " + field.name + " did not pick writer -> " + writer.description);
          else
            console.log("field " + field.name + " picked writer " + oldWriter.description + " -> " + writer.description);
        }
      } else if (IoTrace) {
        console.log("field " + field.name + " writer forced + " + writer.description);
      }

      this.serializeValueWithKnownTag(writer, value, tag);
    } catch (exc) {
      console.log("Failed while writing field " + field.name + " of type " + shape.name);
      throw exc;
    }
  };


  JsAstModule.prototype.serializeObjectContents = function (writer, node, canBeInlined, isInline) {
    if (Array.isArray(node))
      throw new Error("Should have serialized inline array");

    var shape = this.getShapeForObject(node);
    if (shape.tagIndex === null)
      throw new Error("Tag table not finalized");

    var shouldOverride = false;
    if (isInline) {
      this.writeInliningFlagAndTypeTag(writer, 1, shape.tagIndex);

      var trace = TraceInlining || (TraceInlinedTypeCount-- > 0);
      if (trace)
        console.log("Inlined", shape.name, shape.tagIndex.toString(16));

      if (
        this.configuration.ValueStreamPerType && 
        this.configuration.PartitionedInlining
      ) {
        writer = this.valueStreams[shape.name];
        shouldOverride = true;

        if (trace)
          console.log("Inlining " + shape.name + " to " + writer.description);
      }
    } else {

      this.writeTypeTag(writer, shape.tagIndex);
    }

    var self = this, fields = shape.shape.fields;
    for (var i = 0, l = fields.length; i < l; i++) {
      var fd = fields[i];
      var value = node[fd.name];

      if (typeof (value) === "undefined")
        value = null;

      this.serializeFieldValue(
        writer, shape, fd, value, shouldOverride
      );

      if (IoTrace)
        console.log("// " + fd.name + " =", value);      
    }
  };


  JsAstModule.prototype.getTypeTagForValue = function (value) {
    var jsType = typeof (value);

    if (value === null)
      return "null";

    // FIXME: names?

    switch (jsType) {
      case "string":
        return "string";

      case "boolean":
        return value ? "true" : "false";

      case "number":
        var i = value | 0;
        if (i === value)
          return "integer";
        else
          return "double";      

      case "object":
        if (Array.isArray(value)) {
          return "array";
        } else if (value.type === "symbol") {
          return "symbol";
        } else {
          var shape = this.getShapeForObject(value);
          return shape.name;
        }

      default: {
        throw new Error("Unhandled value type " + jsType);
      }
    }       
  };


  JsAstModule.prototype.getIndexForTypeTag = function (tag) {
    return this.tags.get_index(tag);
  };


  JsAstModule.prototype.getTableForTypeTag = function (tag, actualValueTag) {
    if (actualValueTag === "null")
      return null;

    if ((tag === "string") || (tag === "symbol"))
      return null;
    else {
      var shape = this.shapes.get(tag);
      if (shape) {
        return this.getObjectTable(shape);
      } else if (tag === "object") {
        return this.getObjectTable("object");
      } else {
        return null;
      }
    }
  };


  JsAstModule.prototype.serializeArray = function (writer, value) {
    writer.writeVarUint32(value.length);
    if (value.length === 0) {
      if (IoTrace)
        console.log("  Wrote empty array to " + writer.description);
      return;
    }

    // The tree-walker figured out whether we need to use 'any' earlier
    var elementTag = this.arrayTypeTags.get(value);
    var elementTagIndex = this.getIndexForTypeTag(elementTag);
    this.writeTypeTag(writer, elementTagIndex, false);

    if (IoTrace)
      console.log("  Writing array of type " + elementTag + " with " + value.length + " item(s) to " + writer.description);

    var elementsInlined = 0;
    try {
      for (var i = 0; i < value.length; i++) {
        var element = value[i];
        var wasInlined = this.serializeValueWithKnownTag(writer, element, elementTag);
        if (wasInlined)
          elementsInlined += 1;
      }
    } catch (e) {
      console.log("Failed while writing array with tag", elementTag);
      throw e;
    }

    if (false)
      console.log(elementsInlined + "/" + value.length + " element(s) of tag " + elementTag + " inlined");
  };


  // Or unknown tag, if you pass 'any', because why not.
  JsAstModule.prototype.serializeValueWithKnownTag = function (writer, value, tag) {
    switch (tag) {
      case "true":
      case "false":
      case "null":
        // no-op. value is encoded by the type tag.
        return true;

      case "boolean":
        writer.writeByte(value ? 1 : 0);
        return true;

      case "integer":
        // TODO: varint?
        writer.writeInt32(value);
        return true;

      case "double":
        writer.writeFloat64(value);
        return true;

      case "string":
        writer.writeUtf8String(value);
        return true;

      case "symbol":
        if (this.configuration.InternedSymbols) {
          writer.writeIndex(value);
        } else {
          writer.writeUtf8String(value);
        }

        return true;

      case "any": {
        if (IoTrace)
          console.log(writer.description + " write any ->");

        // FIXME: gross.
        tag = this.getTypeTagForValue(value);
        if (tag === "any")
          throw new Error("Couldn't identify a tag for 'any' value");

        this.anyTypeValuesWritten += 1;
        var tagIndex = this.getIndexForTypeTag(tag);
        this.writeTypeTag(writer, tagIndex, false);

        return this.serializeValueWithKnownTag(writer, value, tag);
      }

      case "array":
        this.serializeArray(writer, value);
        return true;

      case "object":
      default:
        break;
    }

    return this.serializeObjectReference(writer, value, tag);
  }


  // Returns true if the reference was inlined
  JsAstModule.prototype.serializeObjectReference = function (writer, value, tag) {
    var shouldConditionalInline = 
      this.configuration.ConditionalInlining &&
      (tag !== "any");

    if (value === null) {
      if (
        shouldConditionalInline
      ) {
        if (TraceInlining)
          console.log("INLINED=null " + tag);

        this.inlinedObjects += 1;
        this.writeInliningFlagAndIndex(writer, 0xFF, 0xFFFFFFFF);
      } else {
        this.notInlinedObjects += 1;
        writer.writeIndex(0xFFFFFFFF);
      }

      return true;
    }

    var actualValueTag = this.getTypeTagForValue(value);
    var table = this.getTableForTypeTag(tag, actualValueTag);
    if (!table)
      throw new Error("No table for value with tag '" + tag + "'");

    var isUntypedObject = (tag === "object");

    if ((actualValueTag !== tag) && !isUntypedObject)
      throw new Error("Shape information specified type '" + tag + "' but actual type is '" + actualValueTag + "'");

    if (IoTrace) {
      if (tag !== actualValueTag)
        console.log(writer.description + " write " + tag + " -> " + actualValueTag);
      else
        console.log(writer.description + " write " + tag);
    }

    try {
      var id, index;
      try {
        id = table.get_id(value);
        index = id.get_index();
      } catch (e) {
        console.log("Failed to get id for value", value, "with tag", actualValueTag, "(expected", tag, ") from table", table.semantic);
        throw e;
      }

      if (shouldConditionalInline) {

        if (id.is_omitted()) {
          if (TraceInlining)
            console.log("INLINED=1 " + tag);

          var name = id.get_name();
          var shape = this.getShapeForObject(value);

          if (shape) {
            // HACK
            var prior = IoTrace;
            if (TraceInlining || (TraceInlinedTypeCount > 0))
              IoTrace = false;

            this.inlinedObjects += 1;
            // serializeObjectContents calls writeInliningFlag
            this.serializeObjectContents(writer, value, true, true);
            IoTrace = prior;

            return true;

          } else {
            throw new Error("Object without shape was omitted");
          }

        } else {
          if (TraceInlining)
            console.log("INLINED=0 " + tag);

          this.notInlinedObjects += 1;

          this.writeInliningFlagAndIndex(writer, 0, index);
        }

      } else {
        writer.writeIndex(index);
      }

    } catch (err) {
      console.log("Failed while writing '" + tag + "'", value);
      throw err;
    }

    return false;
  };


  JsAstModule.prototype.serializeTable = function (writer, table, ordered, serializeEntry) {
    var finalized = table.finalize(0);

    writer.writeUint32(finalized.length);

    for (var i = 0, l = finalized.length; i < l; i++) {
      var id = finalized[i];
      var value = id.get_value();

      // gross
      serializeEntry.call(this, writer, value);
    }
  };


  JsAstModule.prototype.finalize = function () {
    this.tags   .finalize(0);
    this.objects.finalize(0);
  };


  function JsAstModuleBuilder (configuration, shapes) {
    AsmlikeJsonTreeBuilder.call(this);

    this.configuration = configuration;
    this.shapes = shapes;

    this.result = new JsAstModule(configuration, shapes);

    this.internSymbols = configuration.InternedSymbols;
    this.localSymbolsBeforeGlobals = configuration.LocalSymbolsBeforeGlobals;

    this.walkedCount = 0;
    this.progressInterval = 20000;
  };

  JsAstModuleBuilder.prototype = Object.create(AsmlikeJsonTreeBuilder.prototype);  
  var _make = AsmlikeJsonTreeBuilder.prototype.make;

  JsAstModuleBuilder.prototype.make = function (key) {
    var result = _make.call(this, key);

    // FIXME: This is a slow operation. RIP
    Object.defineProperty(result, "__id__", {
      configurable: false,
      enumerable: false,
      value: NextObjectId()
    });

    return result;
  };

  JsAstModuleBuilder.prototype.finalizeArray = function (array) {
    if (array.length === 0)
      return;

    var commonTypeTag = null;

    for (var i = 0, l = array.length; i < l; i++) {
      var item = array[i];
      var tag = this.result.getTypeTagForValue(item);

      // HACK: We know that we don't have primitives mixed in
      //  with objects in arrays, so we can cheat here.
      if (
        (tag !== "string") && 
        (tag !== "integer") && 
        (tag !== "double") && 
        (tag !== "symbol") &&
        !Array.isArray(item)
      ) {
        // console.log(tag, "-> object");
        tag = "object";
      }

      if (commonTypeTag === null) {
        commonTypeTag = tag;
      } else if (commonTypeTag !== tag) {
        console.log("tag mismatch", commonTypeTag, tag);
        commonTypeTag = null;
        break;
      }
    }
    
    if (commonTypeTag === null) {
      console.log("any tag fallback for", array);
      commonTypeTag = "any";
    }

    this.result.arrayTypeTags.set(array, commonTypeTag);

    for (var i = 0, l = array.length; i < l; i++) {
      var element = array[i];

      if (Array.isArray(element))
        this.finalizeArray(element);
      else if (typeof (element) !== "object")
        this.finalizeValue(element);
    }

    return array;
  };

  JsAstModuleBuilder.prototype.finalizeValue = function (value) {
    var tag = this.result.getTypeTagForValue(value);
    this.result.tags.add(tag);

    var table = this.result.getTableForTypeTag(tag);
    if (table)
      table.add(value);

    return value;
  };

  JsAstModuleBuilder.prototype.finalize = function (node) {
    if (!node)
      return;

    this.walkedCount++;
    if ((this.walkedCount % this.progressInterval) === 0) {
      if (typeof (process) === "object")
        process.stderr.write(".");
    }

    if (Array.isArray(node)) {
      return this.finalizeArray(node);
    } else {
      for (var k in node) {
        if (!node.hasOwnProperty(k))
          continue;

        var value = node[k];

        // Handle non-object properties
        if (typeof (value) !== "object")
          this.finalizeValue(value);
        else if (Array.isArray(value))
          this.finalizeArray(value);

        // Otherwise, it's been finalized since it was returned
        //  by the builder.
      }

      return this.finalizeValue(node);
    }
  };

  JsAstModuleBuilder.prototype.finish = function (root) {
    if (this.getHitCount) {
      var self = this;
      this.result.objects.forEach(function (id) {
        var hitCount = self.getHitCount(id.get_value());
        id.set_hit_count(hitCount);
      });    
    }

    var rootTag = this.result.getTypeTagForValue(root);
    var rootTable = this.result.getTableForTypeTag(rootTag);
    rootTable.add(root);

    this.result.root = root;
    this.result.externalSymbolCount = this.externalSymbolCount;
    this.result.maxLocalSymbolCount = this.maxLocalSymbolCount;

    return this.result;
  };


  // Converts a JsAstModule into bytes and writes them into byteWriter.
  function serializeModule (module) {
    var writer = new ValueWriter(module.configuration, "module");

    writer.writeBytes(common.Magic);

    var omitCount = 0, totalCount = module.objects.get_count();
    if (module.configuration.ConditionalInlining) {
      var self = this;
      var maybeOmitCallback = function (id) {
        var hitCount = id.get_hit_count();
        var shape = module.getShapeForObject(id.get_value());
        var omitDueToHitCount = hitCount <= module.configuration.InlineUseCountThreshold,
          omitDueToSize = false;

        if (shape)
          omitDueToSize = module.isShapeSmall(shape);

        if (omitDueToHitCount || omitDueToSize) {
          module.objects.omit(id);
          omitCount += 1;
        }
      };

      module.objects.forEach(maybeOmitCallback);
    }

    module.finalize();

    // We write out the lengths in advance of the (length-prefixed) tables.
    // This allows a decoder to preallocate space for all the tables and
    //  use that to reconstruct relationships in a single pass.

    var tagCount    = module.tags.get_count();
    var objectCount = module.objects.get_count();

    writer.writeUint32(tagCount);
    writer.writeUint32(objectCount);

    var tagWriter = new ValueWriter(module.configuration, "tag table", writer);
    module.serializeTable(tagWriter, module.tags, true, function (_, value) {
      _.writeUtf8String(value);
    });

    if (
      module.configuration.ConditionalInlining &&
      !module.configuration.PackedInliningFlags
    )
      module.inliningWriter = new ValueWriter(module.configuration, "inlining flags", writer);

    if (module.configuration.TypeTagStream)
      module.typeTagWriter = new ValueWriter(module.configuration, "type tags", writer);

    if (
      module.configuration.PackedInliningFlags && 
      module.configuration.PackedIndexStream
    )
      module.packedIndexWriter = new ValueWriter(module.configuration, "packed indices", writer);

    if (module.configuration.ValueStreamPerType)
      module.createValueStreams(writer);

    var objectWriter = new ValueWriter(module.configuration, "object table", writer);
    module.serializeTable(objectWriter, module.objects, true,  module.serializeObjectContents);


    var rootWriter = new ValueWriter(module.configuration, "root node", writer);
    module.serializeValueWithKnownTag(rootWriter, module.root, "any");


    writer.writeSubstream(tagWriter);


    if (module.inliningWriter)
      writer.writeSubstream(module.inliningWriter);

    if (module.typeTagWriter)
      writer.writeSubstream(module.typeTagWriter);

    if (module.packedIndexWriter)
      writer.writeSubstream(module.packedIndexWriter);


    if (module.configuration.ValueStreamPerType)
    for (var key in module.valueStreams) {
      var valueStream = module.valueStreams[key];
      writer.writeIndex(module.tags.get_index(key));      
      writer.writeSubstream(valueStream);
    }


    writer.writeSubstream(objectWriter);
    writer.writeSubstream(rootWriter);

    if (module.configuration.ConditionalInlining) {
      var total = module.notInlinedObjects + module.inlinedObjects;

      console.log(
        module.inlinedObjects + "/" +
        total + " object references written inline (" +
        (module.inlinedObjects * 100 / total).toFixed(1) + "%)"
      );
    }

    if (omitCount > 0) {
      console.log(
        omitCount + "/" + totalCount +
        " objects omitted from object table (" + (omitCount * 100 / totalCount).toFixed(1) + "%)"
      );
    }

    if (module.configuration.TypeTagStream)
      console.log((module.typeTagsWritten / 1000).toFixed(2) + "k type tags written");

    if (module.configuration.EnableVarints) {
      var varintSizes = "";
      var totalVarintSize = 0;
      for (var i = 0; i < writer.varintSizes.length; i++) {
        totalVarintSize += (i + 1) * writer.varintSizes[i];

        if (writer.varintSizes[i]) {
          if (varintSizes.length)
            varintSizes += ", ";

          varintSizes += (i + 1) + "b " + (writer.varintSizes[i] / 1000).toFixed(2) + "k";
        }
      }

      console.log(
        (totalVarintSize / 1024).toFixed(1) + "KiB varints written (" +
        varintSizes + ")"
      ); 
    }

    if (module.configuration.InternedSymbols) {
      console.log(
        module.externalSymbolCount + " externally visible symbols, " +
        module.maxLocalSymbolCount + " max local symbols"
      );
    }

    return writer.toArray();
  };


  exports.PrettyJson         = common.PrettyJson;
  exports.ShapeTable         = common.ShapeTable;
  exports.JsAstModuleBuilder = JsAstModuleBuilder;

  exports.serializeModule    = serializeModule;
}));