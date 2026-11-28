// Generated from schema/definition.schema.json; do not edit.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = __commonJS({
  "node_modules/fast-deep-equal/index.js"(exports, module) {
    "use strict";
    module.exports = function equal(a, b) {
      if (a === b) return true;
      if (a && b && typeof a == "object" && typeof b == "object") {
        if (a.constructor !== b.constructor) return false;
        var length, i, keys;
        if (Array.isArray(a)) {
          length = a.length;
          if (length != b.length) return false;
          for (i = length; i-- !== 0; )
            if (!equal(a[i], b[i])) return false;
          return true;
        }
        if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
        if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
        if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
        keys = Object.keys(a);
        length = keys.length;
        if (length !== Object.keys(b).length) return false;
        for (i = length; i-- !== 0; )
          if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
        for (i = length; i-- !== 0; ) {
          var key = keys[i];
          if (!equal(a[key], b[key])) return false;
        }
        return true;
      }
      return a !== a && b !== b;
    };
  }
});

// node_modules/ajv/dist/runtime/equal.js
var require_equal = __commonJS({
  "node_modules/ajv/dist/runtime/equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var equal = require_fast_deep_equal();
    equal.code = 'require("ajv/dist/runtime/equal").default';
    exports.default = equal;
  }
});

// schema-validator.mjs
var validate = validate20;
var schema31 = { "$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "definition.schema.json", "title": "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u306E\u5B9A\u7FA9", "type": "object", "additionalProperties": false, "required": ["format", "id", "version", "title", "purpose", "phases", "deliverables", "acceptance"], "properties": { "format": { "const": 1, "description": "\u5B9A\u7FA9\u306E\u5F62\u306E\u7248" }, "id": { "$ref": "#/$defs/id" }, "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" }, "title": { "type": "string", "minLength": 1 }, "purpose": { "type": "string", "minLength": 1, "description": "\u3053\u306E\u5B9A\u7FA9\u3067\u4F55\u3092\u4F5C\u308B\u304B" }, "phases": { "type": "array", "minItems": 1, "items": { "type": "object", "additionalProperties": false, "required": ["id", "name", "purpose", "after", "deliverables", "acceptance"], "properties": { "id": { "$ref": "#/$defs/id" }, "name": { "type": "string", "minLength": 1 }, "purpose": { "type": "string", "minLength": 1 }, "after": { "type": "array", "items": { "$ref": "#/$defs/id" }, "description": "\u5148\u306B\u7D42\u3048\u3066\u3044\u308B\u5DE5\u7A0B" }, "deliverables": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/id" } }, "acceptance": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/id" }, "description": "\u3053\u306E\u5DE5\u7A0B\u3092\u7D42\u3048\u308B\u6761\u4EF6" }, "icon": { "type": "string", "pattern": "^[a-z][a-z0-9]*(-[a-z0-9]+)*$", "description": "\u753B\u9762\u3067\u5DE5\u7A0B\u3084\u307E\u3068\u307E\u308A\u306E\u6A2A\u306B\u51FA\u3059\u30A2\u30A4\u30B3\u30F3\u306E\u540D\u524D\uFF08\u82F1\u5C0F\u6587\u5B57\u306E\u8A9E\u3092\u30CF\u30A4\u30D5\u30F3\u3067\u3064\u306A\u3050\u3002\u4F8B lightbulb\u30FBruler\u30FBfile-text\uFF09\u3002\u4F7F\u3046\u5074\u304C\u77E5\u3089\u306A\u3044\u540D\u524D\u306A\u3089\u3001\u51FA\u3055\u305A\u306B\u540D\u524D\u3060\u3051\u3092\u898B\u305B\u3066\u3088\u3044" } } } }, "sections": { "type": "array", "description": "\u5DE5\u7A0B\u306E\u307E\u3068\u307E\u308A\u306E\u65E2\u5B9A\u306E\u5206\u3051\u65B9\u3002\u3069\u306E\u5DE5\u7A0B\u3082\u3061\u3087\u3046\u3069 1 \u3064\u306E\u307E\u3068\u307E\u308A\u306B\u5165\u308A\u3001\u307E\u3068\u307E\u308A\u306E\u4E26\u3073\u3068\u4E2D\u306E\u5DE5\u7A0B\u306E\u4E26\u3073\u306F\u5DE5\u7A0B\u306E\u9806\u306B\u5F93\u3046\u3002\u4F7F\u3046\u5074\u306F\u3053\u308C\u3092\u51FA\u767A\u70B9\u306B\u5206\u3051\u65B9\u3092\u5909\u3048\u3066\u3088\u3044", "items": { "type": "object", "additionalProperties": false, "required": ["id", "name", "phases"], "properties": { "id": { "$ref": "#/$defs/id" }, "name": { "type": "string", "minLength": 1 }, "phases": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/id" }, "description": "\u3053\u306E\u307E\u3068\u307E\u308A\u306B\u5165\u308B\u5DE5\u7A0B\u3002\u5DE5\u7A0B\u306E\u9806\u306B\u4E26\u3079\u308B" }, "icon": { "type": "string", "pattern": "^[a-z][a-z0-9]*(-[a-z0-9]+)*$", "description": "\u753B\u9762\u3067\u5DE5\u7A0B\u3084\u307E\u3068\u307E\u308A\u306E\u6A2A\u306B\u51FA\u3059\u30A2\u30A4\u30B3\u30F3\u306E\u540D\u524D\uFF08\u82F1\u5C0F\u6587\u5B57\u306E\u8A9E\u3092\u30CF\u30A4\u30D5\u30F3\u3067\u3064\u306A\u3050\u3002\u4F8B lightbulb\u30FBruler\u30FBfile-text\uFF09\u3002\u4F7F\u3046\u5074\u304C\u77E5\u3089\u306A\u3044\u540D\u524D\u306A\u3089\u3001\u51FA\u3055\u305A\u306B\u540D\u524D\u3060\u3051\u3092\u898B\u305B\u3066\u3088\u3044" } } } }, "deliverables": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["id", "name", "form", "outline"], "properties": { "id": { "$ref": "#/$defs/id" }, "name": { "type": "string", "minLength": 1 }, "form": { "type": "string", "minLength": 1, "description": "\u6210\u679C\u7269\u306E\u8868\u73FE\u5F62\u614B\u3002\u8868\u793A\u7528\u306E\u5206\u985E\u3067\u3042\u308AEditor kind\u3084\u51FA\u529B\u5F62\u5F0F\u3092\u56FA\u5B9A\u3057\u306A\u3044\u3002\u7DE8\u96C6\u30FB\u51FA\u529B\u306E\u53EF\u5426\u306FEditor Platform\u306E\u516C\u958Bcapabilities\u306B\u5F93\u3046" }, "outline": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/section" }, "description": "\u898B\u51FA\u3057\u306E\u4E26\u3073\u3002\u4EBA\u304C\u78BA\u304B\u3081\u308B\u9806" }, "uses": { "type": "array", "items": { "$ref": "#/$defs/id" }, "description": "\u3082\u3068\u306B\u3059\u308B\u6210\u679C\u7269" }, "view": { "$ref": "#/$defs/view" } } } }, "items": { "type": "array", "description": "ID \u3092\u6301\u3064\u9805\u76EE\u306E\u7A2E\u985E\u3002\u5F71\u97FF\u3068\u7DB2\u7F85\u306F\u3053\u306E\u8868\u3068 rules \u3060\u3051\u3067\u6C7A\u3081\u308B", "items": { "type": "object", "additionalProperties": false, "required": ["id", "name", "idForm"], "properties": { "id": { "$ref": "#/$defs/id" }, "name": { "type": "string", "minLength": 1 }, "idForm": { "type": "string", "description": "\u9805\u76EE\u306E ID \u306E\u5F62\u3002{nn}\u30FB{nnn} \u306F\u6841\u3092\u305D\u308D\u3048\u305F\u9023\u756A\u3001{n} \u306F\u9023\u756A\u3001{parent} \u306F\u89AA\u306E\u9805\u76EE\u306E ID" }, "parent": { "$ref": "#/$defs/id", "description": "\u89AA\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3002ID \u306F\u89AA\u306E ID \u304B\u3089\u4F5C\u308B" } } } }, "rules": { "type": "array", "description": "\u5F15\u7528\u3068\u7DB2\u7F85\u306E\u898F\u5247", "items": { "type": "object", "additionalProperties": false, "required": ["id", "type"], "properties": { "id": { "$ref": "#/$defs/id" }, "type": { "enum": ["cites", "covered"] }, "from": { "$ref": "#/$defs/id", "description": "cites\uFF1A\u5F15\u7528\u3059\u308B\u5074\u306E\u9805\u76EE\u306E\u7A2E\u985E" }, "to": { "type": "array", "items": { "$ref": "#/$defs/id" }, "description": "cites\uFF1A\u5F15\u7528\u3067\u304D\u308B\u5148\u306E\u9805\u76EE\u306E\u7A2E\u985E" }, "min": { "type": "integer", "minimum": 0, "description": "cites\uFF1A\u5C11\u306A\u304F\u3068\u3082\u3044\u304F\u3064\u5F15\u7528\u3059\u308B\u304B\u30020 \u306A\u3089\u3001\u5F15\u3051\u308B\u304C\u5F15\u304B\u306A\u304F\u3066\u3088\u3044" }, "of": { "$ref": "#/$defs/id", "description": "covered\uFF1A\u5F15\u7528\u3055\u308C\u308B\u5074\u306E\u9805\u76EE\u306E\u7A2E\u985E" }, "by": { "type": "array", "items": { "$ref": "#/$defs/id" }, "description": "covered\uFF1A\u5F15\u7528\u3059\u308B\u5074\u306E\u9805\u76EE\u306E\u7A2E\u985E" }, "exempt": { "const": true, "description": "covered\uFF1A\u7406\u7531\u3092\u66F8\u3051\u3070\u9664\u3051\u308B" } } } }, "strictCites": { "const": true, "description": "true \u306A\u3089\u3001\u5F15\u7528\u306F cites \u898F\u5247\u304C\u8A31\u3059\u7A2E\u985E\u306E\u7D44\u3060\u3051\u3002\u898F\u5247\u306B\u7121\u3044\u7D44\uFF08\u5411\u304D\u304C\u9006\u30FB\u7A2E\u985E\u304C\u9055\u3046\uFF09\u306E\u5F15\u7528\u3092\u3001\u4F7F\u3046\u5074\u306F\u9055\u53CD\u3068\u3057\u3066\u51FA\u3057\u3001\u305D\u306E\u5F15\u7528\u3092\u6301\u3064\u5DE5\u7A0B\u306E\u53D7\u3051\u5165\u308C\u3092\u6B62\u3081\u3001Editor \u306E\u5019\u88DC\u304B\u3089\u9078\u3076\u53E3\u3067\u3082\u65AD\u308B\u3002\u66F8\u304B\u306A\u3051\u308C\u3070\u3001\u898F\u5247\u306B\u7121\u3044\u7D44\u306E\u6271\u3044\u306F\u4F7F\u3046\u5074\u306B\u4EFB\u305B\u308B\uFF08\u898B\u672C\u306E\u691C\u67FB\u306F\u3001\u3069\u306E\u5B9A\u7FA9\u3067\u3082\u898F\u5247\u306B\u7121\u3044\u7D44\u3092\u843D\u3068\u3059\uFF09" }, "roles": { "type": "array", "description": "\u4EBA\u306E\u9054\u6210\u6761\u4EF6\u3092\u78BA\u304B\u3081\u308B\u5F79\u5272\u3002\u4EBA\u306E\u540D\u524D\u306F\u66F8\u304B\u305A\u3001\u3069\u306E\u4EBA\u304C\u5F79\u5272\u3092\u6301\u3064\u304B\u306F\u4F7F\u3046\u5074\u304C\u6C7A\u3081\u308B", "items": { "type": "object", "additionalProperties": false, "required": ["id", "name"], "properties": { "id": { "$ref": "#/$defs/id" }, "name": { "type": "string", "minLength": 1 }, "text": { "type": "string", "minLength": 1, "description": "\u5F79\u5272\u306E\u8AAC\u660E" } } } }, "acceptance": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["id", "text", "checkedBy", "target"], "properties": { "id": { "$ref": "#/$defs/id" }, "text": { "type": "string", "minLength": 1 }, "checkedBy": { "enum": ["\u4EBA", "AI"] }, "target": { "$ref": "#/$defs/id", "description": "\u78BA\u304B\u3081\u308B\u6210\u679C\u7269" }, "rules": { "type": "array", "items": { "$ref": "#/$defs/id" }, "description": "\u3053\u306E\u6761\u4EF6\u3092\u6A5F\u68B0\u3067\u78BA\u304B\u3081\u308B\u898F\u5247" }, "approvers": { "type": "object", "additionalProperties": false, "required": ["roles"], "description": "\u4EBA\u306E\u6761\u4EF6\u3092\u78BA\u304B\u3081\u308B\u4EBA\u306E\u6C7A\u307E\u308A\uFF08\u4EBA\u306E\u6761\u4EF6\u3060\u3051\uFF09\u3002\u3069\u308C\u304B\u306E\u5F79\u5272\u3092\u6301\u3064\u3001\u9055\u3046\u4EBA\u306E\u78BA\u304B\u3081\u304C count \u4EBA\u5206\u3042\u308C\u3070\u6E80\u305F\u3059", "properties": { "roles": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/id" }, "description": "\u78BA\u304B\u3081\u308B\u5F79\u5272\uFF08roles \u306E id\uFF09" }, "count": { "type": "integer", "minimum": 1, "description": "\u8981\u308B\u4EBA\u6570\uFF08\u65E2\u5B9A 1\uFF09" } } } } } }, "gates": { "type": "array", "description": "\u65E2\u5B9A\u306E\u30B2\u30FC\u30C8\u3002\u5DE5\u7A0B\u306E\u4F5C\u696D\u306E\u3042\u3068\u306B\u5229\u7528\u5074\u306E\u9053\u5177\u304C\u6D41\u3059\u691C\u67FB\u306E\u30B3\u30DE\u30F3\u30C9\u3002Project \u3092\u59CB\u3081\u308B\u3068\u304D\u306B\u5229\u7528\u5074\u306E\u8A2D\u5B9A\u3078\u5199\u3057\u3001\u5229\u7528\u5074\u304C\u81EA\u5206\u306E\u9053\u5177\u306B\u5408\u308F\u305B\u3066\u5909\u3048\u3066\u3088\u3044", "items": { "$ref": "#/$defs/gate" } }, "placements": { "type": "array", "minItems": 1, "description": "\u7F6E\u304D\u5834\u6240\u306E\u5F62\uFF08\u4EFB\u610F\uFF09\u3002\u540C\u3058\u5DE5\u7A0B\u306E\u307E\u307E\u3001\u4F5C\u308B\u3082\u306E\u3092\u7F6E\u304F\u30EA\u30DD\u30B8\u30C8\u30EA\u306E\u5F62\u3054\u3068\u306B\u3001\u65E2\u5B9A\u306E\u30B2\u30FC\u30C8\u3068\u6210\u679C\u7269\u306E\u7F6E\u304D\u5834\u6240\u3092\u5909\u3048\u308B\u3002\u5229\u7528\u5074\u306F Project \u3092\u59CB\u3081\u308B\u3068\u304D\u306B 1 \u3064\u9078\u3076\uFF08\u6700\u521D\u306E\u3082\u306E\u304C\u65E2\u5B9A\uFF09\u3002\u9078\u3093\u3060\u5F62\u306E gates \u306F\u5B9A\u7FA9\u306E gates \u306E\u4EE3\u308F\u308A\u306B\u5199\u3057\u3001paths \u306F\u6210\u679C\u7269\u306E\u7F6E\u304D\u5834\u6240\u3092\u5909\u3048\u308B", "items": { "$ref": "#/$defs/placement" } } }, "$defs": { "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, "section": { "type": "object", "additionalProperties": false, "required": ["heading", "describe"], "properties": { "heading": { "type": "string", "minLength": 1 }, "describe": { "type": "string", "minLength": 1, "description": "\u3053\u306E\u898B\u51FA\u3057\u306E\u4E0B\u306B\u66F8\u304F\u3053\u3068" }, "repeat": { "const": true, "description": "\u9805\u76EE\u3054\u3068\u306B\u7E70\u308A\u8FD4\u3059\u898B\u51FA\u3057\uFF08\u30B9\u30C8\u30FC\u30EA\u30FC\u3054\u3068\u30FB\u753B\u9762\u3054\u3068\u306A\u3069\uFF09\u3002\u898B\u51FA\u3057\u306E\u6587\u5B57\u306F\u9805\u76EE\u306E\u540D\u524D\u306B\u7F6E\u304D\u63DB\u3048\u308B" }, "children": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/section" } }, "item": { "$ref": "#/$defs/id", "description": "\u3053\u306E\u898B\u51FA\u3057\u306E\u4E0B\u306E\u4E00\u3064\u4E00\u3064\u304C\u3001\u3053\u306E\u7A2E\u985E\u306E\u9805\u76EE\u306B\u306A\u308B" } } }, "view": { "description": "\u6210\u679C\u7269\u306E\u898B\u305B\u65B9\uFF08\u4EFB\u610F\uFF09\u3002\u56F3\u30FB\u30AB\u30F3\u30D0\u30F3\u30FB\u30BF\u30A4\u30E0\u30E9\u30A4\u30F3\u30FB\u30AB\u30EC\u30F3\u30C0\u30FC\u30FB\u8868\u30FB\u30D5\u30A9\u30FC\u30E0\u30FB\u30DE\u30C8\u30EA\u30AF\u30B9\u3092 1 \u3064\u304B\u3001\u914D\u5217\u3067\u5E7E\u3064\u3067\u3082\uFF08as \u3054\u3068\u306B 1 \u3064\u307E\u3067\uFF09\u3002\u9053\u5177\u306F\u898B\u305B\u65B9\u3054\u3068\u306B\u898B\u3048\u65B9\u3092\u51FA\u3057\u3001\u6700\u521D\u306E\u898B\u305B\u65B9\u3067\u958B\u304F\u3002\u6C7A\u3081\u306A\u3044\u6210\u679C\u7269\u306F\u3001\u9053\u5177\u304C\u4E2D\u8EAB\u306E\u5F62\u304B\u3089\u958B\u304D\u65B9\u3092\u6C7A\u3081\u308B", "oneOf": [{ "$ref": "#/$defs/oneView" }, { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/oneView" } }] }, "graphView": { "type": "object", "additionalProperties": false, "required": ["as", "nodes"], "description": "\u56F3\uFF08as: graph\uFF09\u3002\u6210\u679C\u7269\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3054\u3068\u306B\u3001\u70B9\u30FB\u7DDA\u30FB\u67A0\u306E\u3069\u308C\u3067\u63CF\u304F\u304B\u3092\u6C7A\u3081\u308B\u3002\u9805\u76EE\u306E\u6B04 in \u306F\u5165\u308B\u67A0\u306E ID\u3001at \u306F\u70B9\u306E\u5834\u6240 [x, y]\u3001frame \u306F\u67A0\u306E\u5834\u6240\u3068\u5927\u304D\u3055 [x, y, \u5E45, \u9AD8\u3055]\uFF08\u3069\u308C\u3082\u5165\u3063\u3066\u3044\u308B\u67A0\u306E\u5DE6\u4E0A\u304B\u3089\u3002\u7121\u3051\u308C\u3070\u9053\u5177\u304C\u4E26\u3079\u308B\uFF09", "properties": { "as": { "const": "graph" }, "nodes": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/id" }, "description": "\u70B9\u306B\u3059\u308B\u9805\u76EE\u306E\u7A2E\u985E" }, "edges": { "type": "array", "items": { "$ref": "#/$defs/id" }, "description": "\u7DDA\u306B\u3059\u308B\u9805\u76EE\u306E\u7A2E\u985E\u3002\u9805\u76EE\u306F from\u30FBto \u306B\u70B9\u306E ID \u3092\u6301\u3064" }, "sections": { "type": "array", "items": { "$ref": "#/$defs/id" }, "description": "\u67A0\u306B\u3059\u308B\u9805\u76EE\u306E\u7A2E\u985E\u3002\u67A0\u306E\u4E2D\u306E\u67A0\u306F in \u306B\u5916\u306E\u67A0\u306E ID" }, "colorBy": { "type": "string", "minLength": 1, "description": "\u70B9\u3068\u67A0\u306E\u8272\u3092\u5206\u3051\u308B\u6B04\u3002\u5024\u3054\u3068\u306B\u8272\u3092\u5909\u3048\u308B\uFF08\u67A0\u306F\u3001\u81EA\u5206\u306E ID \u304C\u305D\u306E\u5024\u306E\u3068\u304D\u3082\u305D\u306E\u8272\uFF09" }, "colors": { "type": "object", "additionalProperties": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }, "description": "colorBy \u306E\u5024 \u2192 \u8272\u3002\u7121\u3044\u5024\u306F\u9053\u5177\u304C\u9078\u3076" }, "edgeColorBy": { "type": "string", "minLength": 1, "description": "\u7DDA\u306E\u8272\u3092\u5206\u3051\u308B\u6B04" }, "edgeColors": { "type": "object", "additionalProperties": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }, "description": "edgeColorBy \u306E\u5024 \u2192 \u8272\u3002\u7121\u3044\u5024\u306F\u9053\u5177\u304C\u9078\u3076" } } }, "kanbanView": { "type": "object", "additionalProperties": false, "required": ["as", "items", "groupBy"], "description": "\u30AB\u30F3\u30D0\u30F3\uFF08as: kanban\uFF09\u30021 \u3064\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3092\u3001\u6B04 groupBy \u306E\u5024\u3054\u3068\u306E\u5217\u306B\u30AB\u30FC\u30C9\u3067\u4E26\u3079\u308B\u3002\u30AB\u30FC\u30C9\u3092\u5225\u306E\u5217\u306B\u52D5\u304B\u3059\u3068\u3001\u305D\u306E\u6B04\u306E\u5024\u304C\u5909\u308F\u308B", "properties": { "as": { "const": "kanban" }, "items": { "$ref": "#/$defs/id", "description": "\u30AB\u30FC\u30C9\u306B\u3059\u308B\u9805\u76EE\u306E\u7A2E\u985E" }, "groupBy": { "type": "string", "minLength": 1, "description": "\u5217\u3092\u5206\u3051\u308B\u6B04" }, "columns": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "\u5217\u306E\u4E26\u3073\uFF08\u5024\uFF09\u3002\u66F8\u304B\u306A\u3044\u5024\u306E\u5217\u306F\u3001\u305D\u306E\u3042\u3068\u306B\u51FA\u308B" }, "card": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "\u30AB\u30FC\u30C9\u306B\u51FA\u3059\u6B04\u3002\u66F8\u304B\u306A\u3051\u308C\u3070\u9053\u5177\u304C\u9078\u3076" } } }, "timelineView": { "type": "object", "additionalProperties": false, "required": ["as", "items", "start", "end"], "description": "\u30BF\u30A4\u30E0\u30E9\u30A4\u30F3\uFF08as: timeline\uFF09\u30021 \u3064\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3092\u3001\u6B04 start \u304B\u3089\u6B04 end \u307E\u3067\u306E\u5E2F\u3067\u65E5\u4ED8\u306E\u8EF8\u306B\u4E26\u3079\u308B\uFF08\u65E5\u4ED8\u306F YYYY-MM-DD\uFF09", "properties": { "as": { "const": "timeline" }, "items": { "$ref": "#/$defs/id", "description": "\u5E2F\u306B\u3059\u308B\u9805\u76EE\u306E\u7A2E\u985E" }, "start": { "type": "string", "minLength": 1, "description": "\u59CB\u307E\u308A\u306E\u65E5\u4ED8\u306E\u6B04" }, "end": { "type": "string", "minLength": 1, "description": "\u7D42\u308F\u308A\u306E\u65E5\u4ED8\u306E\u6B04" }, "groupBy": { "type": "string", "minLength": 1, "description": "\u5E2F\u306E\u884C\u3092\u5206\u3051\u308B\u6B04" }, "scale": { "enum": ["day", "week", "month"], "description": "\u8EF8\u306E\u76EE\u76DB\u308A" } } }, "calendarView": { "type": "object", "additionalProperties": false, "required": ["as", "items", "date"], "description": "\u30AB\u30EC\u30F3\u30C0\u30FC\uFF08as: calendar\uFF09\u30021 \u3064\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3092\u3001\u6B04 date \u306E\u65E5\uFF08end \u304C\u3042\u308C\u3070 date \u304B\u3089 end \u307E\u3067\uFF09\u306B\u6708\u306E\u66A6\u3067\u4E26\u3079\u308B\uFF08\u65E5\u4ED8\u306F YYYY-MM-DD\uFF09\u3002\u671F\u9650\u306E\u3088\u3046\u306B\u65E5\u4ED8\u304C 1 \u3064\u306E\u9805\u76EE\u306B\u5411\u304F", "properties": { "as": { "const": "calendar" }, "items": { "$ref": "#/$defs/id", "description": "\u66A6\u306B\u7F6E\u304F\u9805\u76EE\u306E\u7A2E\u985E" }, "date": { "type": "string", "minLength": 1, "description": "\u65E5\u4ED8\u306E\u6B04\uFF08\u59CB\u307E\u308A\u306E\u65E5\uFF09" }, "end": { "type": "string", "minLength": 1, "description": "\u7D42\u308F\u308A\u306E\u65E5\u4ED8\u306E\u6B04\u3002\u7121\u3051\u308C\u3070 date \u306E\u65E5\u3060\u3051" } } }, "tableView": { "type": "object", "additionalProperties": false, "required": ["as", "items"], "description": "\u8868\uFF08as: table\uFF09\u30021 \u3064\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3092\u8868\u3067\u958B\u304F\u3068\u304D\u306E\u3001\u6B04\u306E\u4E26\u3073\u30FB\u4E26\u3079\u66FF\u3048\u30FB\u307E\u3068\u3081\u65B9\u30FB\u96A0\u3059\u6B04\u3092\u6C7A\u3081\u308B\u3002\u6C7A\u3081\u306A\u3051\u308C\u3070\u9053\u5177\u304C\u6C7A\u3081\u308B", "properties": { "as": { "const": "table" }, "items": { "$ref": "#/$defs/id", "description": "\u8868\u306B\u3059\u308B\u9805\u76EE\u306E\u7A2E\u985E" }, "columns": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "\u6B04\u306E\u4E26\u3073\u3002\u66F8\u304B\u306A\u3044\u6B04\u306F\u3001\u305D\u306E\u3042\u3068\u306B\u51FA\u308B" }, "sort": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["by"], "properties": { "by": { "type": "string", "minLength": 1, "description": "\u4E26\u3079\u66FF\u3048\u308B\u6B04" }, "desc": { "type": "boolean", "description": "\u5927\u304D\u3044\u9806\uFF08\u65B0\u3057\u3044\u9806\uFF09\u3002\u7121\u3051\u308C\u3070\u5C0F\u3055\u3044\u9806" } } }, "description": "\u4E26\u3079\u66FF\u3048\u3002\u524D\u306E\u3082\u306E\u307B\u3069\u5148\u306B\u52B9\u304F" }, "groupBy": { "type": "string", "minLength": 1, "description": "\u884C\u3092\u307E\u3068\u3081\u308B\u6B04" }, "hide": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "\u96A0\u3059\u6B04" } } }, "formView": { "type": "object", "additionalProperties": false, "required": ["as", "items"], "description": "\u30D5\u30A9\u30FC\u30E0\uFF08as: form\uFF09\u30021 \u3064\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3092\u30011 \u4EF6\u305A\u3064\u306E\u5165\u529B\u306E\u753B\u9762\u3067\u958B\u304F\u3002\u6B04\u306E\u591A\u3044\u53F0\u5E33\u306B\u5411\u304F", "properties": { "as": { "const": "form" }, "items": { "$ref": "#/$defs/id", "description": "1 \u4EF6\u305A\u3064\u958B\u304F\u9805\u76EE\u306E\u7A2E\u985E" }, "fields": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "\u6B04\u306E\u4E26\u3073\u3002\u66F8\u304B\u306A\u3044\u6B04\u306F\u3001\u305D\u306E\u3042\u3068\u306B\u51FA\u308B" } } }, "matrixView": { "type": "object", "additionalProperties": false, "required": ["as", "rows", "columns"], "description": "\u30DE\u30C8\u30EA\u30AF\u30B9\uFF08as: matrix\uFF09\u3002\u884C\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3068\u5217\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3092\u4E26\u3079\u3001\u5F15\u7528\u306E\u8868\u306B\u3042\u308B\u7D44\u306E\u307E\u3059\u76EE\u306B\u5370\u3092\u4ED8\u3051\u308B\u3002\u307E\u3059\u76EE\u3092\u5207\u308A\u66FF\u3048\u308B\u3068\u3001\u5F15\u7528\u306E\u8868\u306E\u7D44\u304C\u5897\u3048\u308B\u30FB\u6E1B\u308B\u3002\u884C\u3068\u5217\u306E\u7A2E\u985E\u306E\u9593\u306B\u306F\u3001\u3069\u3061\u3089\u5411\u304D\u304B\u306E\u5F15\u7528\u306E\u898F\u5247\uFF08cites\uFF09\u304C\u8981\u308B", "properties": { "as": { "const": "matrix" }, "rows": { "$ref": "#/$defs/id", "description": "\u884C\u306E\u9805\u76EE\u306E\u7A2E\u985E\uFF08\u3053\u306E\u6210\u679C\u7269\u306E\u9805\u76EE\uFF09" }, "columns": { "$ref": "#/$defs/id", "description": "\u5217\u306E\u9805\u76EE\u306E\u7A2E\u985E\uFF08\u5B9A\u7FA9\u306E\u3069\u306E\u9805\u76EE\u3067\u3082\u3088\u3044\uFF09" } } }, "oneView": { "oneOf": [{ "$ref": "#/$defs/graphView" }, { "$ref": "#/$defs/kanbanView" }, { "$ref": "#/$defs/timelineView" }, { "$ref": "#/$defs/calendarView" }, { "$ref": "#/$defs/tableView" }, { "$ref": "#/$defs/formView" }, { "$ref": "#/$defs/matrixView" }] }, "gate": { "type": "object", "additionalProperties": false, "required": ["name", "run"], "properties": { "name": { "type": "string", "minLength": 1, "description": "\u30B2\u30FC\u30C8\u306E\u540D\u524D\uFF08\u7D50\u679C\u306B\u51FA\u308B\uFF09" }, "run": { "type": "string", "minLength": 1, "description": "\u6D41\u3059\u30B3\u30DE\u30F3\u30C9\uFF08\u4F5C\u696D\u306E\u5834\u6240\u3067 shell \u304C\u6D41\u3059\uFF09" }, "limitSeconds": { "type": "number", "exclusiveMinimum": 0, "description": "\u5236\u9650\u6642\u9593\uFF08\u79D2\uFF09" }, "phases": { "type": "array", "minItems": 1, "uniqueItems": true, "items": { "$ref": "#/$defs/id" }, "description": "\u6D41\u3059\u5DE5\u7A0B\u3002\u7121\u3051\u308C\u3070\u3069\u306E\u5DE5\u7A0B\u3067\u3082\u6D41\u3059" } } }, "placement": { "type": "object", "additionalProperties": false, "required": ["id", "name"], "properties": { "id": { "$ref": "#/$defs/id" }, "name": { "type": "string", "minLength": 1 }, "text": { "type": "string", "minLength": 1, "description": "\u3069\u3093\u306A\u3068\u304D\u306B\u9078\u3076\u304B" }, "gates": { "type": "array", "items": { "$ref": "#/$defs/gate" }, "description": "\u3053\u306E\u5F62\u306E\u65E2\u5B9A\u306E\u30B2\u30FC\u30C8\u3002\u66F8\u3051\u3070\u5B9A\u7FA9\u306E gates \u306E\u4EE3\u308F\u308A\u306B\u5199\u3059\u3002\u66F8\u304B\u306A\u3051\u308C\u3070\u5B9A\u7FA9\u306E gates" }, "paths": { "type": "object", "additionalProperties": { "type": "string", "minLength": 1, "pattern": "^(?!/)(?![\\s\\S]*\\.\\.)[^\\\\\\r\\n\\u2028\\u2029]+$" }, "description": "\u6210\u679C\u7269\u306E ID \u2192 \u7F6E\u304D\u5834\u6240\uFF08\u30EA\u30DD\u30B8\u30C8\u30EA\u306E\u4E2D\u306E\u76F8\u5BFE\u306E path\u3002.. \u3068 \\ \u3068\u6539\u884C\u3092\u542B\u307E\u306A\u3044\u3002/ \u3067\u7D42\u308F\u308C\u3070\u5834\u6240\u306E\u4E0B\u306E\u30D5\u30A1\u30A4\u30EB\u5168\u90E8\uFF09\u3002\u66F8\u304B\u306A\u3044\u6210\u679C\u7269\u306F\u5229\u7528\u5074\u306E\u65E2\u5B9A\u306E\u7F6E\u304D\u5834\u6240" } } } } };
var func1 = Object.prototype.hasOwnProperty;
var func2 = require_ucs2length().default;
var pattern4 = new RegExp("^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$", "u");
var pattern5 = new RegExp("^[0-9]+\\.[0-9]+\\.[0-9]+$", "u");
var pattern10 = new RegExp("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", "u");
var wrapper0 = { validate: validate21 };
function validate21(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate21.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.heading === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "heading" }, message: "must have required property 'heading'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.describe === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "describe" }, message: "must have required property 'describe'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "heading" || key0 === "describe" || key0 === "repeat" || key0 === "children" || key0 === "item")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.heading !== void 0) {
      let data0 = data.heading;
      if (typeof data0 === "string") {
        if (func2(data0) < 1) {
          const err3 = { instancePath: instancePath + "/heading", schemaPath: "#/properties/heading/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = { instancePath: instancePath + "/heading", schemaPath: "#/properties/heading/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.describe !== void 0) {
      let data1 = data.describe;
      if (typeof data1 === "string") {
        if (func2(data1) < 1) {
          const err5 = { instancePath: instancePath + "/describe", schemaPath: "#/properties/describe/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/describe", schemaPath: "#/properties/describe/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.repeat !== void 0) {
      if (true !== data.repeat) {
        const err7 = { instancePath: instancePath + "/repeat", schemaPath: "#/properties/repeat/const", keyword: "const", params: { allowedValue: true }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.children !== void 0) {
      let data3 = data.children;
      if (Array.isArray(data3)) {
        if (data3.length < 1) {
          const err8 = { instancePath: instancePath + "/children", schemaPath: "#/properties/children/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!wrapper0.validate(data3[i0], { instancePath: instancePath + "/children/" + i0, parentData: data3, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? wrapper0.validate.errors : vErrors.concat(wrapper0.validate.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err9 = { instancePath: instancePath + "/children", schemaPath: "#/properties/children/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.item !== void 0) {
      let data5 = data.item;
      if (typeof data5 === "string") {
        if (!pattern4.test(data5)) {
          const err10 = { instancePath: instancePath + "/item", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      } else {
        const err11 = { instancePath: instancePath + "/item", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
  } else {
    const err12 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err12];
    } else {
      vErrors.push(err12);
    }
    errors++;
  }
  validate21.errors = vErrors;
  return errors === 0;
}
validate21.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var pattern20 = new RegExp("^#[0-9a-fA-F]{6}$", "u");
function validate25(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate25.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.as === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "as" }, message: "must have required property 'as'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.nodes === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "nodes" }, message: "must have required property 'nodes'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "as" || key0 === "nodes" || key0 === "edges" || key0 === "sections" || key0 === "colorBy" || key0 === "colors" || key0 === "edgeColorBy" || key0 === "edgeColors")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.as !== void 0) {
      if ("graph" !== data.as) {
        const err3 = { instancePath: instancePath + "/as", schemaPath: "#/properties/as/const", keyword: "const", params: { allowedValue: "graph" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.nodes !== void 0) {
      let data1 = data.nodes;
      if (Array.isArray(data1)) {
        if (data1.length < 1) {
          const err4 = { instancePath: instancePath + "/nodes", schemaPath: "#/properties/nodes/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
        const len0 = data1.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data2 = data1[i0];
          if (typeof data2 === "string") {
            if (!pattern4.test(data2)) {
              const err5 = { instancePath: instancePath + "/nodes/" + i0, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
              if (vErrors === null) {
                vErrors = [err5];
              } else {
                vErrors.push(err5);
              }
              errors++;
            }
          } else {
            const err6 = { instancePath: instancePath + "/nodes/" + i0, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err6];
            } else {
              vErrors.push(err6);
            }
            errors++;
          }
        }
      } else {
        const err7 = { instancePath: instancePath + "/nodes", schemaPath: "#/properties/nodes/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.edges !== void 0) {
      let data3 = data.edges;
      if (Array.isArray(data3)) {
        const len1 = data3.length;
        for (let i1 = 0; i1 < len1; i1++) {
          let data4 = data3[i1];
          if (typeof data4 === "string") {
            if (!pattern4.test(data4)) {
              const err8 = { instancePath: instancePath + "/edges/" + i1, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
              if (vErrors === null) {
                vErrors = [err8];
              } else {
                vErrors.push(err8);
              }
              errors++;
            }
          } else {
            const err9 = { instancePath: instancePath + "/edges/" + i1, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err9];
            } else {
              vErrors.push(err9);
            }
            errors++;
          }
        }
      } else {
        const err10 = { instancePath: instancePath + "/edges", schemaPath: "#/properties/edges/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.sections !== void 0) {
      let data5 = data.sections;
      if (Array.isArray(data5)) {
        const len2 = data5.length;
        for (let i2 = 0; i2 < len2; i2++) {
          let data6 = data5[i2];
          if (typeof data6 === "string") {
            if (!pattern4.test(data6)) {
              const err11 = { instancePath: instancePath + "/sections/" + i2, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
              if (vErrors === null) {
                vErrors = [err11];
              } else {
                vErrors.push(err11);
              }
              errors++;
            }
          } else {
            const err12 = { instancePath: instancePath + "/sections/" + i2, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err12];
            } else {
              vErrors.push(err12);
            }
            errors++;
          }
        }
      } else {
        const err13 = { instancePath: instancePath + "/sections", schemaPath: "#/properties/sections/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.colorBy !== void 0) {
      let data7 = data.colorBy;
      if (typeof data7 === "string") {
        if (func2(data7) < 1) {
          const err14 = { instancePath: instancePath + "/colorBy", schemaPath: "#/properties/colorBy/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = { instancePath: instancePath + "/colorBy", schemaPath: "#/properties/colorBy/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.colors !== void 0) {
      let data8 = data.colors;
      if (data8 && typeof data8 == "object" && !Array.isArray(data8)) {
        for (const key1 in data8) {
          let data9 = data8[key1];
          if (typeof data9 === "string") {
            if (!pattern20.test(data9)) {
              const err16 = { instancePath: instancePath + "/colors/" + key1.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/properties/colors/additionalProperties/pattern", keyword: "pattern", params: { pattern: "^#[0-9a-fA-F]{6}$" }, message: 'must match pattern "^#[0-9a-fA-F]{6}$"' };
              if (vErrors === null) {
                vErrors = [err16];
              } else {
                vErrors.push(err16);
              }
              errors++;
            }
          } else {
            const err17 = { instancePath: instancePath + "/colors/" + key1.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/properties/colors/additionalProperties/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err17];
            } else {
              vErrors.push(err17);
            }
            errors++;
          }
        }
      } else {
        const err18 = { instancePath: instancePath + "/colors", schemaPath: "#/properties/colors/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
    if (data.edgeColorBy !== void 0) {
      let data10 = data.edgeColorBy;
      if (typeof data10 === "string") {
        if (func2(data10) < 1) {
          const err19 = { instancePath: instancePath + "/edgeColorBy", schemaPath: "#/properties/edgeColorBy/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err19];
          } else {
            vErrors.push(err19);
          }
          errors++;
        }
      } else {
        const err20 = { instancePath: instancePath + "/edgeColorBy", schemaPath: "#/properties/edgeColorBy/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
    if (data.edgeColors !== void 0) {
      let data11 = data.edgeColors;
      if (data11 && typeof data11 == "object" && !Array.isArray(data11)) {
        for (const key2 in data11) {
          let data12 = data11[key2];
          if (typeof data12 === "string") {
            if (!pattern20.test(data12)) {
              const err21 = { instancePath: instancePath + "/edgeColors/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/properties/edgeColors/additionalProperties/pattern", keyword: "pattern", params: { pattern: "^#[0-9a-fA-F]{6}$" }, message: 'must match pattern "^#[0-9a-fA-F]{6}$"' };
              if (vErrors === null) {
                vErrors = [err21];
              } else {
                vErrors.push(err21);
              }
              errors++;
            }
          } else {
            const err22 = { instancePath: instancePath + "/edgeColors/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/properties/edgeColors/additionalProperties/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err22];
            } else {
              vErrors.push(err22);
            }
            errors++;
          }
        }
      } else {
        const err23 = { instancePath: instancePath + "/edgeColors", schemaPath: "#/properties/edgeColors/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
    }
  } else {
    const err24 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err24];
    } else {
      vErrors.push(err24);
    }
    errors++;
  }
  validate25.errors = vErrors;
  return errors === 0;
}
validate25.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate27(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate27.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.as === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "as" }, message: "must have required property 'as'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.items === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "items" }, message: "must have required property 'items'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.groupBy === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "groupBy" }, message: "must have required property 'groupBy'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "as" || key0 === "items" || key0 === "groupBy" || key0 === "columns" || key0 === "card")) {
        const err3 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.as !== void 0) {
      if ("kanban" !== data.as) {
        const err4 = { instancePath: instancePath + "/as", schemaPath: "#/properties/as/const", keyword: "const", params: { allowedValue: "kanban" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.items !== void 0) {
      let data1 = data.items;
      if (typeof data1 === "string") {
        if (!pattern4.test(data1)) {
          const err5 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.groupBy !== void 0) {
      let data2 = data.groupBy;
      if (typeof data2 === "string") {
        if (func2(data2) < 1) {
          const err7 = { instancePath: instancePath + "/groupBy", schemaPath: "#/properties/groupBy/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/groupBy", schemaPath: "#/properties/groupBy/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.columns !== void 0) {
      let data3 = data.columns;
      if (Array.isArray(data3)) {
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data4 = data3[i0];
          if (typeof data4 === "string") {
            if (func2(data4) < 1) {
              const err9 = { instancePath: instancePath + "/columns/" + i0, schemaPath: "#/properties/columns/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err9];
              } else {
                vErrors.push(err9);
              }
              errors++;
            }
          } else {
            const err10 = { instancePath: instancePath + "/columns/" + i0, schemaPath: "#/properties/columns/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err10];
            } else {
              vErrors.push(err10);
            }
            errors++;
          }
        }
      } else {
        const err11 = { instancePath: instancePath + "/columns", schemaPath: "#/properties/columns/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.card !== void 0) {
      let data5 = data.card;
      if (Array.isArray(data5)) {
        const len1 = data5.length;
        for (let i1 = 0; i1 < len1; i1++) {
          let data6 = data5[i1];
          if (typeof data6 === "string") {
            if (func2(data6) < 1) {
              const err12 = { instancePath: instancePath + "/card/" + i1, schemaPath: "#/properties/card/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err12];
              } else {
                vErrors.push(err12);
              }
              errors++;
            }
          } else {
            const err13 = { instancePath: instancePath + "/card/" + i1, schemaPath: "#/properties/card/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err13];
            } else {
              vErrors.push(err13);
            }
            errors++;
          }
        }
      } else {
        const err14 = { instancePath: instancePath + "/card", schemaPath: "#/properties/card/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
  } else {
    const err15 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err15];
    } else {
      vErrors.push(err15);
    }
    errors++;
  }
  validate27.errors = vErrors;
  return errors === 0;
}
validate27.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var schema51 = { "type": "object", "additionalProperties": false, "required": ["as", "items", "start", "end"], "description": "\u30BF\u30A4\u30E0\u30E9\u30A4\u30F3\uFF08as: timeline\uFF09\u30021 \u3064\u306E\u9805\u76EE\u306E\u7A2E\u985E\u3092\u3001\u6B04 start \u304B\u3089\u6B04 end \u307E\u3067\u306E\u5E2F\u3067\u65E5\u4ED8\u306E\u8EF8\u306B\u4E26\u3079\u308B\uFF08\u65E5\u4ED8\u306F YYYY-MM-DD\uFF09", "properties": { "as": { "const": "timeline" }, "items": { "$ref": "#/$defs/id", "description": "\u5E2F\u306B\u3059\u308B\u9805\u76EE\u306E\u7A2E\u985E" }, "start": { "type": "string", "minLength": 1, "description": "\u59CB\u307E\u308A\u306E\u65E5\u4ED8\u306E\u6B04" }, "end": { "type": "string", "minLength": 1, "description": "\u7D42\u308F\u308A\u306E\u65E5\u4ED8\u306E\u6B04" }, "groupBy": { "type": "string", "minLength": 1, "description": "\u5E2F\u306E\u884C\u3092\u5206\u3051\u308B\u6B04" }, "scale": { "enum": ["day", "week", "month"], "description": "\u8EF8\u306E\u76EE\u76DB\u308A" } } };
function validate29(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate29.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.as === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "as" }, message: "must have required property 'as'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.items === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "items" }, message: "must have required property 'items'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.start === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "start" }, message: "must have required property 'start'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.end === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "end" }, message: "must have required property 'end'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "as" || key0 === "items" || key0 === "start" || key0 === "end" || key0 === "groupBy" || key0 === "scale")) {
        const err4 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.as !== void 0) {
      if ("timeline" !== data.as) {
        const err5 = { instancePath: instancePath + "/as", schemaPath: "#/properties/as/const", keyword: "const", params: { allowedValue: "timeline" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.items !== void 0) {
      let data1 = data.items;
      if (typeof data1 === "string") {
        if (!pattern4.test(data1)) {
          const err6 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      } else {
        const err7 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.start !== void 0) {
      let data2 = data.start;
      if (typeof data2 === "string") {
        if (func2(data2) < 1) {
          const err8 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
      } else {
        const err9 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.end !== void 0) {
      let data3 = data.end;
      if (typeof data3 === "string") {
        if (func2(data3) < 1) {
          const err10 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      } else {
        const err11 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.groupBy !== void 0) {
      let data4 = data.groupBy;
      if (typeof data4 === "string") {
        if (func2(data4) < 1) {
          const err12 = { instancePath: instancePath + "/groupBy", schemaPath: "#/properties/groupBy/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      } else {
        const err13 = { instancePath: instancePath + "/groupBy", schemaPath: "#/properties/groupBy/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.scale !== void 0) {
      let data5 = data.scale;
      if (!(data5 === "day" || data5 === "week" || data5 === "month")) {
        const err14 = { instancePath: instancePath + "/scale", schemaPath: "#/properties/scale/enum", keyword: "enum", params: { allowedValues: schema51.properties.scale.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
  } else {
    const err15 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err15];
    } else {
      vErrors.push(err15);
    }
    errors++;
  }
  validate29.errors = vErrors;
  return errors === 0;
}
validate29.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate31(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate31.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.as === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "as" }, message: "must have required property 'as'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.items === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "items" }, message: "must have required property 'items'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.date === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "date" }, message: "must have required property 'date'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "as" || key0 === "items" || key0 === "date" || key0 === "end")) {
        const err3 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.as !== void 0) {
      if ("calendar" !== data.as) {
        const err4 = { instancePath: instancePath + "/as", schemaPath: "#/properties/as/const", keyword: "const", params: { allowedValue: "calendar" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.items !== void 0) {
      let data1 = data.items;
      if (typeof data1 === "string") {
        if (!pattern4.test(data1)) {
          const err5 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.date !== void 0) {
      let data2 = data.date;
      if (typeof data2 === "string") {
        if (func2(data2) < 1) {
          const err7 = { instancePath: instancePath + "/date", schemaPath: "#/properties/date/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/date", schemaPath: "#/properties/date/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.end !== void 0) {
      let data3 = data.end;
      if (typeof data3 === "string") {
        if (func2(data3) < 1) {
          const err9 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
  } else {
    const err11 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err11];
    } else {
      vErrors.push(err11);
    }
    errors++;
  }
  validate31.errors = vErrors;
  return errors === 0;
}
validate31.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate33(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate33.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.as === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "as" }, message: "must have required property 'as'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.items === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "items" }, message: "must have required property 'items'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "as" || key0 === "items" || key0 === "columns" || key0 === "sort" || key0 === "groupBy" || key0 === "hide")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.as !== void 0) {
      if ("table" !== data.as) {
        const err3 = { instancePath: instancePath + "/as", schemaPath: "#/properties/as/const", keyword: "const", params: { allowedValue: "table" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.items !== void 0) {
      let data1 = data.items;
      if (typeof data1 === "string") {
        if (!pattern4.test(data1)) {
          const err4 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      } else {
        const err5 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.columns !== void 0) {
      let data2 = data.columns;
      if (Array.isArray(data2)) {
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data3 = data2[i0];
          if (typeof data3 === "string") {
            if (func2(data3) < 1) {
              const err6 = { instancePath: instancePath + "/columns/" + i0, schemaPath: "#/properties/columns/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err6];
              } else {
                vErrors.push(err6);
              }
              errors++;
            }
          } else {
            const err7 = { instancePath: instancePath + "/columns/" + i0, schemaPath: "#/properties/columns/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err7];
            } else {
              vErrors.push(err7);
            }
            errors++;
          }
        }
      } else {
        const err8 = { instancePath: instancePath + "/columns", schemaPath: "#/properties/columns/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.sort !== void 0) {
      let data4 = data.sort;
      if (Array.isArray(data4)) {
        const len1 = data4.length;
        for (let i1 = 0; i1 < len1; i1++) {
          let data5 = data4[i1];
          if (data5 && typeof data5 == "object" && !Array.isArray(data5)) {
            if (data5.by === void 0) {
              const err9 = { instancePath: instancePath + "/sort/" + i1, schemaPath: "#/properties/sort/items/required", keyword: "required", params: { missingProperty: "by" }, message: "must have required property 'by'" };
              if (vErrors === null) {
                vErrors = [err9];
              } else {
                vErrors.push(err9);
              }
              errors++;
            }
            for (const key1 in data5) {
              if (!(key1 === "by" || key1 === "desc")) {
                const err10 = { instancePath: instancePath + "/sort/" + i1, schemaPath: "#/properties/sort/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err10];
                } else {
                  vErrors.push(err10);
                }
                errors++;
              }
            }
            if (data5.by !== void 0) {
              let data6 = data5.by;
              if (typeof data6 === "string") {
                if (func2(data6) < 1) {
                  const err11 = { instancePath: instancePath + "/sort/" + i1 + "/by", schemaPath: "#/properties/sort/items/properties/by/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err11];
                  } else {
                    vErrors.push(err11);
                  }
                  errors++;
                }
              } else {
                const err12 = { instancePath: instancePath + "/sort/" + i1 + "/by", schemaPath: "#/properties/sort/items/properties/by/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err12];
                } else {
                  vErrors.push(err12);
                }
                errors++;
              }
            }
            if (data5.desc !== void 0) {
              if (typeof data5.desc !== "boolean") {
                const err13 = { instancePath: instancePath + "/sort/" + i1 + "/desc", schemaPath: "#/properties/sort/items/properties/desc/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
                if (vErrors === null) {
                  vErrors = [err13];
                } else {
                  vErrors.push(err13);
                }
                errors++;
              }
            }
          } else {
            const err14 = { instancePath: instancePath + "/sort/" + i1, schemaPath: "#/properties/sort/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err14];
            } else {
              vErrors.push(err14);
            }
            errors++;
          }
        }
      } else {
        const err15 = { instancePath: instancePath + "/sort", schemaPath: "#/properties/sort/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.groupBy !== void 0) {
      let data8 = data.groupBy;
      if (typeof data8 === "string") {
        if (func2(data8) < 1) {
          const err16 = { instancePath: instancePath + "/groupBy", schemaPath: "#/properties/groupBy/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
      } else {
        const err17 = { instancePath: instancePath + "/groupBy", schemaPath: "#/properties/groupBy/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.hide !== void 0) {
      let data9 = data.hide;
      if (Array.isArray(data9)) {
        const len2 = data9.length;
        for (let i2 = 0; i2 < len2; i2++) {
          let data10 = data9[i2];
          if (typeof data10 === "string") {
            if (func2(data10) < 1) {
              const err18 = { instancePath: instancePath + "/hide/" + i2, schemaPath: "#/properties/hide/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err18];
              } else {
                vErrors.push(err18);
              }
              errors++;
            }
          } else {
            const err19 = { instancePath: instancePath + "/hide/" + i2, schemaPath: "#/properties/hide/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err19];
            } else {
              vErrors.push(err19);
            }
            errors++;
          }
        }
      } else {
        const err20 = { instancePath: instancePath + "/hide", schemaPath: "#/properties/hide/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
  } else {
    const err21 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err21];
    } else {
      vErrors.push(err21);
    }
    errors++;
  }
  validate33.errors = vErrors;
  return errors === 0;
}
validate33.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate35(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate35.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.as === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "as" }, message: "must have required property 'as'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.items === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "items" }, message: "must have required property 'items'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "as" || key0 === "items" || key0 === "fields")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.as !== void 0) {
      if ("form" !== data.as) {
        const err3 = { instancePath: instancePath + "/as", schemaPath: "#/properties/as/const", keyword: "const", params: { allowedValue: "form" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.items !== void 0) {
      let data1 = data.items;
      if (typeof data1 === "string") {
        if (!pattern4.test(data1)) {
          const err4 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      } else {
        const err5 = { instancePath: instancePath + "/items", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.fields !== void 0) {
      let data2 = data.fields;
      if (Array.isArray(data2)) {
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data3 = data2[i0];
          if (typeof data3 === "string") {
            if (func2(data3) < 1) {
              const err6 = { instancePath: instancePath + "/fields/" + i0, schemaPath: "#/properties/fields/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err6];
              } else {
                vErrors.push(err6);
              }
              errors++;
            }
          } else {
            const err7 = { instancePath: instancePath + "/fields/" + i0, schemaPath: "#/properties/fields/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err7];
            } else {
              vErrors.push(err7);
            }
            errors++;
          }
        }
      } else {
        const err8 = { instancePath: instancePath + "/fields", schemaPath: "#/properties/fields/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
  } else {
    const err9 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err9];
    } else {
      vErrors.push(err9);
    }
    errors++;
  }
  validate35.errors = vErrors;
  return errors === 0;
}
validate35.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate37(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate37.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.as === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "as" }, message: "must have required property 'as'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.rows === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "rows" }, message: "must have required property 'rows'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.columns === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "columns" }, message: "must have required property 'columns'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "as" || key0 === "rows" || key0 === "columns")) {
        const err3 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.as !== void 0) {
      if ("matrix" !== data.as) {
        const err4 = { instancePath: instancePath + "/as", schemaPath: "#/properties/as/const", keyword: "const", params: { allowedValue: "matrix" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.rows !== void 0) {
      let data1 = data.rows;
      if (typeof data1 === "string") {
        if (!pattern4.test(data1)) {
          const err5 = { instancePath: instancePath + "/rows", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/rows", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.columns !== void 0) {
      let data2 = data.columns;
      if (typeof data2 === "string") {
        if (!pattern4.test(data2)) {
          const err7 = { instancePath: instancePath + "/columns", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/columns", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
  } else {
    const err9 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err9];
    } else {
      vErrors.push(err9);
    }
    errors++;
  }
  validate37.errors = vErrors;
  return errors === 0;
}
validate37.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate24(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate24.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  const _errs0 = errors;
  let valid0 = false;
  let passing0 = null;
  const _errs1 = errors;
  if (!validate25(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate25.errors : vErrors.concat(validate25.errors);
    errors = vErrors.length;
  }
  var _valid0 = _errs1 === errors;
  if (_valid0) {
    valid0 = true;
    passing0 = 0;
    var props0 = true;
  }
  const _errs2 = errors;
  if (!validate27(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate27.errors : vErrors.concat(validate27.errors);
    errors = vErrors.length;
  }
  var _valid0 = _errs2 === errors;
  if (_valid0 && valid0) {
    valid0 = false;
    passing0 = [passing0, 1];
  } else {
    if (_valid0) {
      valid0 = true;
      passing0 = 1;
      if (props0 !== true) {
        props0 = true;
      }
    }
    const _errs3 = errors;
    if (!validate29(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
      vErrors = vErrors === null ? validate29.errors : vErrors.concat(validate29.errors);
      errors = vErrors.length;
    }
    var _valid0 = _errs3 === errors;
    if (_valid0 && valid0) {
      valid0 = false;
      passing0 = [passing0, 2];
    } else {
      if (_valid0) {
        valid0 = true;
        passing0 = 2;
        if (props0 !== true) {
          props0 = true;
        }
      }
      const _errs4 = errors;
      if (!validate31(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
        vErrors = vErrors === null ? validate31.errors : vErrors.concat(validate31.errors);
        errors = vErrors.length;
      }
      var _valid0 = _errs4 === errors;
      if (_valid0 && valid0) {
        valid0 = false;
        passing0 = [passing0, 3];
      } else {
        if (_valid0) {
          valid0 = true;
          passing0 = 3;
          if (props0 !== true) {
            props0 = true;
          }
        }
        const _errs5 = errors;
        if (!validate33(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
          vErrors = vErrors === null ? validate33.errors : vErrors.concat(validate33.errors);
          errors = vErrors.length;
        }
        var _valid0 = _errs5 === errors;
        if (_valid0 && valid0) {
          valid0 = false;
          passing0 = [passing0, 4];
        } else {
          if (_valid0) {
            valid0 = true;
            passing0 = 4;
            if (props0 !== true) {
              props0 = true;
            }
          }
          const _errs6 = errors;
          if (!validate35(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate35.errors : vErrors.concat(validate35.errors);
            errors = vErrors.length;
          }
          var _valid0 = _errs6 === errors;
          if (_valid0 && valid0) {
            valid0 = false;
            passing0 = [passing0, 5];
          } else {
            if (_valid0) {
              valid0 = true;
              passing0 = 5;
              if (props0 !== true) {
                props0 = true;
              }
            }
            const _errs7 = errors;
            if (!validate37(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
              vErrors = vErrors === null ? validate37.errors : vErrors.concat(validate37.errors);
              errors = vErrors.length;
            }
            var _valid0 = _errs7 === errors;
            if (_valid0 && valid0) {
              valid0 = false;
              passing0 = [passing0, 6];
            } else {
              if (_valid0) {
                valid0 = true;
                passing0 = 6;
                if (props0 !== true) {
                  props0 = true;
                }
              }
            }
          }
        }
      }
    }
  }
  if (!valid0) {
    const err0 = { instancePath, schemaPath: "#/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  } else {
    errors = _errs0;
    if (vErrors !== null) {
      if (_errs0) {
        vErrors.length = _errs0;
      } else {
        vErrors = null;
      }
    }
  }
  validate24.errors = vErrors;
  evaluated0.props = props0;
  return errors === 0;
}
validate24.evaluated = { "dynamicProps": true, "dynamicItems": false };
function validate23(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate23.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  const _errs0 = errors;
  let valid0 = false;
  let passing0 = null;
  const _errs1 = errors;
  if (!validate24(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate24.errors : vErrors.concat(validate24.errors);
    errors = vErrors.length;
  } else {
    var props0 = validate24.evaluated.props;
  }
  var _valid0 = _errs1 === errors;
  if (_valid0) {
    valid0 = true;
    passing0 = 0;
  }
  const _errs2 = errors;
  if (Array.isArray(data)) {
    if (data.length < 1) {
      const err0 = { instancePath, schemaPath: "#/oneOf/1/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    const len0 = data.length;
    for (let i0 = 0; i0 < len0; i0++) {
      if (!validate24(data[i0], { instancePath: instancePath + "/" + i0, parentData: data, parentDataProperty: i0, rootData, dynamicAnchors })) {
        vErrors = vErrors === null ? validate24.errors : vErrors.concat(validate24.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err1 = { instancePath, schemaPath: "#/oneOf/1/type", keyword: "type", params: { type: "array" }, message: "must be array" };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  var _valid0 = _errs2 === errors;
  if (_valid0 && valid0) {
    valid0 = false;
    passing0 = [passing0, 1];
  } else {
    if (_valid0) {
      valid0 = true;
      passing0 = 1;
      var items0 = true;
    }
  }
  if (!valid0) {
    const err2 = { instancePath, schemaPath: "#/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
    if (vErrors === null) {
      vErrors = [err2];
    } else {
      vErrors.push(err2);
    }
    errors++;
  } else {
    errors = _errs0;
    if (vErrors !== null) {
      if (_errs0) {
        vErrors.length = _errs0;
      } else {
        vErrors = null;
      }
    }
  }
  validate23.errors = vErrors;
  evaluated0.props = props0;
  evaluated0.items = items0;
  return errors === 0;
}
validate23.evaluated = { "dynamicProps": true, "dynamicItems": true };
var func0 = require_equal().default;
function validate42(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate42.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.name === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.run === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "run" }, message: "must have required property 'run'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "name" || key0 === "run" || key0 === "limitSeconds" || key0 === "phases")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.name !== void 0) {
      let data0 = data.name;
      if (typeof data0 === "string") {
        if (func2(data0) < 1) {
          const err3 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.run !== void 0) {
      let data1 = data.run;
      if (typeof data1 === "string") {
        if (func2(data1) < 1) {
          const err5 = { instancePath: instancePath + "/run", schemaPath: "#/properties/run/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/run", schemaPath: "#/properties/run/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.limitSeconds !== void 0) {
      let data2 = data.limitSeconds;
      if (typeof data2 == "number") {
        if (data2 <= 0 || isNaN(data2)) {
          const err7 = { instancePath: instancePath + "/limitSeconds", schemaPath: "#/properties/limitSeconds/exclusiveMinimum", keyword: "exclusiveMinimum", params: { comparison: ">", limit: 0 }, message: "must be > 0" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/limitSeconds", schemaPath: "#/properties/limitSeconds/type", keyword: "type", params: { type: "number" }, message: "must be number" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.phases !== void 0) {
      let data3 = data.phases;
      if (Array.isArray(data3)) {
        if (data3.length < 1) {
          const err9 = { instancePath: instancePath + "/phases", schemaPath: "#/properties/phases/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data4 = data3[i0];
          if (typeof data4 === "string") {
            if (!pattern4.test(data4)) {
              const err10 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
              if (vErrors === null) {
                vErrors = [err10];
              } else {
                vErrors.push(err10);
              }
              errors++;
            }
          } else {
            const err11 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err11];
            } else {
              vErrors.push(err11);
            }
            errors++;
          }
        }
        let i1 = data3.length;
        let j0;
        if (i1 > 1) {
          outer0: for (; i1--; ) {
            for (j0 = i1; j0--; ) {
              if (func0(data3[i1], data3[j0])) {
                const err12 = { instancePath: instancePath + "/phases", schemaPath: "#/properties/phases/uniqueItems", keyword: "uniqueItems", params: { i: i1, j: j0 }, message: "must NOT have duplicate items (items ## " + j0 + " and " + i1 + " are identical)" };
                if (vErrors === null) {
                  vErrors = [err12];
                } else {
                  vErrors.push(err12);
                }
                errors++;
                break outer0;
              }
            }
          }
        }
      } else {
        const err13 = { instancePath: instancePath + "/phases", schemaPath: "#/properties/phases/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
  } else {
    const err14 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err14];
    } else {
      vErrors.push(err14);
    }
    errors++;
  }
  validate42.errors = vErrors;
  return errors === 0;
}
validate42.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var pattern43 = new RegExp("^(?!/)(?![\\s\\S]*\\.\\.)[^\\\\\\r\\n\\u2028\\u2029]+$", "u");
function validate44(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate44.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.name === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "id" || key0 === "name" || key0 === "text" || key0 === "gates" || key0 === "paths")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.id !== void 0) {
      let data0 = data.id;
      if (typeof data0 === "string") {
        if (!pattern4.test(data0)) {
          const err3 = { instancePath: instancePath + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = { instancePath: instancePath + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.name !== void 0) {
      let data1 = data.name;
      if (typeof data1 === "string") {
        if (func2(data1) < 1) {
          const err5 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.text !== void 0) {
      let data2 = data.text;
      if (typeof data2 === "string") {
        if (func2(data2) < 1) {
          const err7 = { instancePath: instancePath + "/text", schemaPath: "#/properties/text/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/text", schemaPath: "#/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.gates !== void 0) {
      let data3 = data.gates;
      if (Array.isArray(data3)) {
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate42(data3[i0], { instancePath: instancePath + "/gates/" + i0, parentData: data3, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate42.errors : vErrors.concat(validate42.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err9 = { instancePath: instancePath + "/gates", schemaPath: "#/properties/gates/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.paths !== void 0) {
      let data5 = data.paths;
      if (data5 && typeof data5 == "object" && !Array.isArray(data5)) {
        for (const key1 in data5) {
          let data6 = data5[key1];
          if (typeof data6 === "string") {
            if (func2(data6) < 1) {
              const err10 = { instancePath: instancePath + "/paths/" + key1.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/properties/paths/additionalProperties/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err10];
              } else {
                vErrors.push(err10);
              }
              errors++;
            }
            if (!pattern43.test(data6)) {
              const err11 = { instancePath: instancePath + "/paths/" + key1.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/properties/paths/additionalProperties/pattern", keyword: "pattern", params: { pattern: "^(?!/)(?![\\s\\S]*\\.\\.)[^\\\\\\r\\n\\u2028\\u2029]+$" }, message: 'must match pattern "^(?!/)(?![\\s\\S]*\\.\\.)[^\\\\\\r\\n\\u2028\\u2029]+$"' };
              if (vErrors === null) {
                vErrors = [err11];
              } else {
                vErrors.push(err11);
              }
              errors++;
            }
          } else {
            const err12 = { instancePath: instancePath + "/paths/" + key1.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/properties/paths/additionalProperties/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err12];
            } else {
              vErrors.push(err12);
            }
            errors++;
          }
        }
      } else {
        const err13 = { instancePath: instancePath + "/paths", schemaPath: "#/properties/paths/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
  } else {
    const err14 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err14];
    } else {
      vErrors.push(err14);
    }
    errors++;
  }
  validate44.errors = vErrors;
  return errors === 0;
}
validate44.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate20(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.format === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "format" }, message: "must have required property 'format'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.id === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.version === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "version" }, message: "must have required property 'version'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.title === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "title" }, message: "must have required property 'title'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.purpose === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "purpose" }, message: "must have required property 'purpose'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.phases === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "phases" }, message: "must have required property 'phases'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.deliverables === void 0) {
      const err6 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "deliverables" }, message: "must have required property 'deliverables'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.acceptance === void 0) {
      const err7 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "acceptance" }, message: "must have required property 'acceptance'" };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema31.properties, key0)) {
        const err8 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.format !== void 0) {
      if (1 !== data.format) {
        const err9 = { instancePath: instancePath + "/format", schemaPath: "#/properties/format/const", keyword: "const", params: { allowedValue: 1 }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.id !== void 0) {
      let data1 = data.id;
      if (typeof data1 === "string") {
        if (!pattern4.test(data1)) {
          const err10 = { instancePath: instancePath + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      } else {
        const err11 = { instancePath: instancePath + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.version !== void 0) {
      let data2 = data.version;
      if (typeof data2 === "string") {
        if (!pattern5.test(data2)) {
          const err12 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/pattern", keyword: "pattern", params: { pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }, message: 'must match pattern "^[0-9]+\\.[0-9]+\\.[0-9]+$"' };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      } else {
        const err13 = { instancePath: instancePath + "/version", schemaPath: "#/properties/version/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.title !== void 0) {
      let data3 = data.title;
      if (typeof data3 === "string") {
        if (func2(data3) < 1) {
          const err14 = { instancePath: instancePath + "/title", schemaPath: "#/properties/title/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = { instancePath: instancePath + "/title", schemaPath: "#/properties/title/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.purpose !== void 0) {
      let data4 = data.purpose;
      if (typeof data4 === "string") {
        if (func2(data4) < 1) {
          const err16 = { instancePath: instancePath + "/purpose", schemaPath: "#/properties/purpose/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
      } else {
        const err17 = { instancePath: instancePath + "/purpose", schemaPath: "#/properties/purpose/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.phases !== void 0) {
      let data5 = data.phases;
      if (Array.isArray(data5)) {
        if (data5.length < 1) {
          const err18 = { instancePath: instancePath + "/phases", schemaPath: "#/properties/phases/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
        const len0 = data5.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data6 = data5[i0];
          if (data6 && typeof data6 == "object" && !Array.isArray(data6)) {
            if (data6.id === void 0) {
              const err19 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err19];
              } else {
                vErrors.push(err19);
              }
              errors++;
            }
            if (data6.name === void 0) {
              const err20 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
              if (vErrors === null) {
                vErrors = [err20];
              } else {
                vErrors.push(err20);
              }
              errors++;
            }
            if (data6.purpose === void 0) {
              const err21 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/required", keyword: "required", params: { missingProperty: "purpose" }, message: "must have required property 'purpose'" };
              if (vErrors === null) {
                vErrors = [err21];
              } else {
                vErrors.push(err21);
              }
              errors++;
            }
            if (data6.after === void 0) {
              const err22 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/required", keyword: "required", params: { missingProperty: "after" }, message: "must have required property 'after'" };
              if (vErrors === null) {
                vErrors = [err22];
              } else {
                vErrors.push(err22);
              }
              errors++;
            }
            if (data6.deliverables === void 0) {
              const err23 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/required", keyword: "required", params: { missingProperty: "deliverables" }, message: "must have required property 'deliverables'" };
              if (vErrors === null) {
                vErrors = [err23];
              } else {
                vErrors.push(err23);
              }
              errors++;
            }
            if (data6.acceptance === void 0) {
              const err24 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/required", keyword: "required", params: { missingProperty: "acceptance" }, message: "must have required property 'acceptance'" };
              if (vErrors === null) {
                vErrors = [err24];
              } else {
                vErrors.push(err24);
              }
              errors++;
            }
            for (const key1 in data6) {
              if (!(key1 === "id" || key1 === "name" || key1 === "purpose" || key1 === "after" || key1 === "deliverables" || key1 === "acceptance" || key1 === "icon")) {
                const err25 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
            }
            if (data6.id !== void 0) {
              let data7 = data6.id;
              if (typeof data7 === "string") {
                if (!pattern4.test(data7)) {
                  const err26 = { instancePath: instancePath + "/phases/" + i0 + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err26];
                  } else {
                    vErrors.push(err26);
                  }
                  errors++;
                }
              } else {
                const err27 = { instancePath: instancePath + "/phases/" + i0 + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err27];
                } else {
                  vErrors.push(err27);
                }
                errors++;
              }
            }
            if (data6.name !== void 0) {
              let data8 = data6.name;
              if (typeof data8 === "string") {
                if (func2(data8) < 1) {
                  const err28 = { instancePath: instancePath + "/phases/" + i0 + "/name", schemaPath: "#/properties/phases/items/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err28];
                  } else {
                    vErrors.push(err28);
                  }
                  errors++;
                }
              } else {
                const err29 = { instancePath: instancePath + "/phases/" + i0 + "/name", schemaPath: "#/properties/phases/items/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err29];
                } else {
                  vErrors.push(err29);
                }
                errors++;
              }
            }
            if (data6.purpose !== void 0) {
              let data9 = data6.purpose;
              if (typeof data9 === "string") {
                if (func2(data9) < 1) {
                  const err30 = { instancePath: instancePath + "/phases/" + i0 + "/purpose", schemaPath: "#/properties/phases/items/properties/purpose/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err30];
                  } else {
                    vErrors.push(err30);
                  }
                  errors++;
                }
              } else {
                const err31 = { instancePath: instancePath + "/phases/" + i0 + "/purpose", schemaPath: "#/properties/phases/items/properties/purpose/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err31];
                } else {
                  vErrors.push(err31);
                }
                errors++;
              }
            }
            if (data6.after !== void 0) {
              let data10 = data6.after;
              if (Array.isArray(data10)) {
                const len1 = data10.length;
                for (let i1 = 0; i1 < len1; i1++) {
                  let data11 = data10[i1];
                  if (typeof data11 === "string") {
                    if (!pattern4.test(data11)) {
                      const err32 = { instancePath: instancePath + "/phases/" + i0 + "/after/" + i1, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err32];
                      } else {
                        vErrors.push(err32);
                      }
                      errors++;
                    }
                  } else {
                    const err33 = { instancePath: instancePath + "/phases/" + i0 + "/after/" + i1, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err33];
                    } else {
                      vErrors.push(err33);
                    }
                    errors++;
                  }
                }
              } else {
                const err34 = { instancePath: instancePath + "/phases/" + i0 + "/after", schemaPath: "#/properties/phases/items/properties/after/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err34];
                } else {
                  vErrors.push(err34);
                }
                errors++;
              }
            }
            if (data6.deliverables !== void 0) {
              let data12 = data6.deliverables;
              if (Array.isArray(data12)) {
                if (data12.length < 1) {
                  const err35 = { instancePath: instancePath + "/phases/" + i0 + "/deliverables", schemaPath: "#/properties/phases/items/properties/deliverables/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
                  if (vErrors === null) {
                    vErrors = [err35];
                  } else {
                    vErrors.push(err35);
                  }
                  errors++;
                }
                const len2 = data12.length;
                for (let i2 = 0; i2 < len2; i2++) {
                  let data13 = data12[i2];
                  if (typeof data13 === "string") {
                    if (!pattern4.test(data13)) {
                      const err36 = { instancePath: instancePath + "/phases/" + i0 + "/deliverables/" + i2, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err36];
                      } else {
                        vErrors.push(err36);
                      }
                      errors++;
                    }
                  } else {
                    const err37 = { instancePath: instancePath + "/phases/" + i0 + "/deliverables/" + i2, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err37];
                    } else {
                      vErrors.push(err37);
                    }
                    errors++;
                  }
                }
              } else {
                const err38 = { instancePath: instancePath + "/phases/" + i0 + "/deliverables", schemaPath: "#/properties/phases/items/properties/deliverables/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err38];
                } else {
                  vErrors.push(err38);
                }
                errors++;
              }
            }
            if (data6.acceptance !== void 0) {
              let data14 = data6.acceptance;
              if (Array.isArray(data14)) {
                if (data14.length < 1) {
                  const err39 = { instancePath: instancePath + "/phases/" + i0 + "/acceptance", schemaPath: "#/properties/phases/items/properties/acceptance/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
                  if (vErrors === null) {
                    vErrors = [err39];
                  } else {
                    vErrors.push(err39);
                  }
                  errors++;
                }
                const len3 = data14.length;
                for (let i3 = 0; i3 < len3; i3++) {
                  let data15 = data14[i3];
                  if (typeof data15 === "string") {
                    if (!pattern4.test(data15)) {
                      const err40 = { instancePath: instancePath + "/phases/" + i0 + "/acceptance/" + i3, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err40];
                      } else {
                        vErrors.push(err40);
                      }
                      errors++;
                    }
                  } else {
                    const err41 = { instancePath: instancePath + "/phases/" + i0 + "/acceptance/" + i3, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err41];
                    } else {
                      vErrors.push(err41);
                    }
                    errors++;
                  }
                }
              } else {
                const err42 = { instancePath: instancePath + "/phases/" + i0 + "/acceptance", schemaPath: "#/properties/phases/items/properties/acceptance/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err42];
                } else {
                  vErrors.push(err42);
                }
                errors++;
              }
            }
            if (data6.icon !== void 0) {
              let data16 = data6.icon;
              if (typeof data16 === "string") {
                if (!pattern10.test(data16)) {
                  const err43 = { instancePath: instancePath + "/phases/" + i0 + "/icon", schemaPath: "#/properties/phases/items/properties/icon/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9]*(-[a-z0-9]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err43];
                  } else {
                    vErrors.push(err43);
                  }
                  errors++;
                }
              } else {
                const err44 = { instancePath: instancePath + "/phases/" + i0 + "/icon", schemaPath: "#/properties/phases/items/properties/icon/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err44];
                } else {
                  vErrors.push(err44);
                }
                errors++;
              }
            }
          } else {
            const err45 = { instancePath: instancePath + "/phases/" + i0, schemaPath: "#/properties/phases/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err45];
            } else {
              vErrors.push(err45);
            }
            errors++;
          }
        }
      } else {
        const err46 = { instancePath: instancePath + "/phases", schemaPath: "#/properties/phases/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err46];
        } else {
          vErrors.push(err46);
        }
        errors++;
      }
    }
    if (data.sections !== void 0) {
      let data17 = data.sections;
      if (Array.isArray(data17)) {
        const len4 = data17.length;
        for (let i4 = 0; i4 < len4; i4++) {
          let data18 = data17[i4];
          if (data18 && typeof data18 == "object" && !Array.isArray(data18)) {
            if (data18.id === void 0) {
              const err47 = { instancePath: instancePath + "/sections/" + i4, schemaPath: "#/properties/sections/items/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err47];
              } else {
                vErrors.push(err47);
              }
              errors++;
            }
            if (data18.name === void 0) {
              const err48 = { instancePath: instancePath + "/sections/" + i4, schemaPath: "#/properties/sections/items/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
              if (vErrors === null) {
                vErrors = [err48];
              } else {
                vErrors.push(err48);
              }
              errors++;
            }
            if (data18.phases === void 0) {
              const err49 = { instancePath: instancePath + "/sections/" + i4, schemaPath: "#/properties/sections/items/required", keyword: "required", params: { missingProperty: "phases" }, message: "must have required property 'phases'" };
              if (vErrors === null) {
                vErrors = [err49];
              } else {
                vErrors.push(err49);
              }
              errors++;
            }
            for (const key2 in data18) {
              if (!(key2 === "id" || key2 === "name" || key2 === "phases" || key2 === "icon")) {
                const err50 = { instancePath: instancePath + "/sections/" + i4, schemaPath: "#/properties/sections/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key2 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err50];
                } else {
                  vErrors.push(err50);
                }
                errors++;
              }
            }
            if (data18.id !== void 0) {
              let data19 = data18.id;
              if (typeof data19 === "string") {
                if (!pattern4.test(data19)) {
                  const err51 = { instancePath: instancePath + "/sections/" + i4 + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err51];
                  } else {
                    vErrors.push(err51);
                  }
                  errors++;
                }
              } else {
                const err52 = { instancePath: instancePath + "/sections/" + i4 + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err52];
                } else {
                  vErrors.push(err52);
                }
                errors++;
              }
            }
            if (data18.name !== void 0) {
              let data20 = data18.name;
              if (typeof data20 === "string") {
                if (func2(data20) < 1) {
                  const err53 = { instancePath: instancePath + "/sections/" + i4 + "/name", schemaPath: "#/properties/sections/items/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err53];
                  } else {
                    vErrors.push(err53);
                  }
                  errors++;
                }
              } else {
                const err54 = { instancePath: instancePath + "/sections/" + i4 + "/name", schemaPath: "#/properties/sections/items/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err54];
                } else {
                  vErrors.push(err54);
                }
                errors++;
              }
            }
            if (data18.phases !== void 0) {
              let data21 = data18.phases;
              if (Array.isArray(data21)) {
                if (data21.length < 1) {
                  const err55 = { instancePath: instancePath + "/sections/" + i4 + "/phases", schemaPath: "#/properties/sections/items/properties/phases/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
                  if (vErrors === null) {
                    vErrors = [err55];
                  } else {
                    vErrors.push(err55);
                  }
                  errors++;
                }
                const len5 = data21.length;
                for (let i5 = 0; i5 < len5; i5++) {
                  let data22 = data21[i5];
                  if (typeof data22 === "string") {
                    if (!pattern4.test(data22)) {
                      const err56 = { instancePath: instancePath + "/sections/" + i4 + "/phases/" + i5, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err56];
                      } else {
                        vErrors.push(err56);
                      }
                      errors++;
                    }
                  } else {
                    const err57 = { instancePath: instancePath + "/sections/" + i4 + "/phases/" + i5, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err57];
                    } else {
                      vErrors.push(err57);
                    }
                    errors++;
                  }
                }
              } else {
                const err58 = { instancePath: instancePath + "/sections/" + i4 + "/phases", schemaPath: "#/properties/sections/items/properties/phases/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err58];
                } else {
                  vErrors.push(err58);
                }
                errors++;
              }
            }
            if (data18.icon !== void 0) {
              let data23 = data18.icon;
              if (typeof data23 === "string") {
                if (!pattern10.test(data23)) {
                  const err59 = { instancePath: instancePath + "/sections/" + i4 + "/icon", schemaPath: "#/properties/sections/items/properties/icon/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9]*(-[a-z0-9]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err59];
                  } else {
                    vErrors.push(err59);
                  }
                  errors++;
                }
              } else {
                const err60 = { instancePath: instancePath + "/sections/" + i4 + "/icon", schemaPath: "#/properties/sections/items/properties/icon/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err60];
                } else {
                  vErrors.push(err60);
                }
                errors++;
              }
            }
          } else {
            const err61 = { instancePath: instancePath + "/sections/" + i4, schemaPath: "#/properties/sections/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err61];
            } else {
              vErrors.push(err61);
            }
            errors++;
          }
        }
      } else {
        const err62 = { instancePath: instancePath + "/sections", schemaPath: "#/properties/sections/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err62];
        } else {
          vErrors.push(err62);
        }
        errors++;
      }
    }
    if (data.deliverables !== void 0) {
      let data24 = data.deliverables;
      if (Array.isArray(data24)) {
        const len6 = data24.length;
        for (let i6 = 0; i6 < len6; i6++) {
          let data25 = data24[i6];
          if (data25 && typeof data25 == "object" && !Array.isArray(data25)) {
            if (data25.id === void 0) {
              const err63 = { instancePath: instancePath + "/deliverables/" + i6, schemaPath: "#/properties/deliverables/items/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err63];
              } else {
                vErrors.push(err63);
              }
              errors++;
            }
            if (data25.name === void 0) {
              const err64 = { instancePath: instancePath + "/deliverables/" + i6, schemaPath: "#/properties/deliverables/items/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
              if (vErrors === null) {
                vErrors = [err64];
              } else {
                vErrors.push(err64);
              }
              errors++;
            }
            if (data25.form === void 0) {
              const err65 = { instancePath: instancePath + "/deliverables/" + i6, schemaPath: "#/properties/deliverables/items/required", keyword: "required", params: { missingProperty: "form" }, message: "must have required property 'form'" };
              if (vErrors === null) {
                vErrors = [err65];
              } else {
                vErrors.push(err65);
              }
              errors++;
            }
            if (data25.outline === void 0) {
              const err66 = { instancePath: instancePath + "/deliverables/" + i6, schemaPath: "#/properties/deliverables/items/required", keyword: "required", params: { missingProperty: "outline" }, message: "must have required property 'outline'" };
              if (vErrors === null) {
                vErrors = [err66];
              } else {
                vErrors.push(err66);
              }
              errors++;
            }
            for (const key3 in data25) {
              if (!(key3 === "id" || key3 === "name" || key3 === "form" || key3 === "outline" || key3 === "uses" || key3 === "view")) {
                const err67 = { instancePath: instancePath + "/deliverables/" + i6, schemaPath: "#/properties/deliverables/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key3 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err67];
                } else {
                  vErrors.push(err67);
                }
                errors++;
              }
            }
            if (data25.id !== void 0) {
              let data26 = data25.id;
              if (typeof data26 === "string") {
                if (!pattern4.test(data26)) {
                  const err68 = { instancePath: instancePath + "/deliverables/" + i6 + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err68];
                  } else {
                    vErrors.push(err68);
                  }
                  errors++;
                }
              } else {
                const err69 = { instancePath: instancePath + "/deliverables/" + i6 + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err69];
                } else {
                  vErrors.push(err69);
                }
                errors++;
              }
            }
            if (data25.name !== void 0) {
              let data27 = data25.name;
              if (typeof data27 === "string") {
                if (func2(data27) < 1) {
                  const err70 = { instancePath: instancePath + "/deliverables/" + i6 + "/name", schemaPath: "#/properties/deliverables/items/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err70];
                  } else {
                    vErrors.push(err70);
                  }
                  errors++;
                }
              } else {
                const err71 = { instancePath: instancePath + "/deliverables/" + i6 + "/name", schemaPath: "#/properties/deliverables/items/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err71];
                } else {
                  vErrors.push(err71);
                }
                errors++;
              }
            }
            if (data25.form !== void 0) {
              let data28 = data25.form;
              if (typeof data28 === "string") {
                if (func2(data28) < 1) {
                  const err72 = { instancePath: instancePath + "/deliverables/" + i6 + "/form", schemaPath: "#/properties/deliverables/items/properties/form/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err72];
                  } else {
                    vErrors.push(err72);
                  }
                  errors++;
                }
              } else {
                const err73 = { instancePath: instancePath + "/deliverables/" + i6 + "/form", schemaPath: "#/properties/deliverables/items/properties/form/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err73];
                } else {
                  vErrors.push(err73);
                }
                errors++;
              }
            }
            if (data25.outline !== void 0) {
              let data29 = data25.outline;
              if (Array.isArray(data29)) {
                if (data29.length < 1) {
                  const err74 = { instancePath: instancePath + "/deliverables/" + i6 + "/outline", schemaPath: "#/properties/deliverables/items/properties/outline/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
                  if (vErrors === null) {
                    vErrors = [err74];
                  } else {
                    vErrors.push(err74);
                  }
                  errors++;
                }
                const len7 = data29.length;
                for (let i7 = 0; i7 < len7; i7++) {
                  if (!validate21(data29[i7], { instancePath: instancePath + "/deliverables/" + i6 + "/outline/" + i7, parentData: data29, parentDataProperty: i7, rootData, dynamicAnchors })) {
                    vErrors = vErrors === null ? validate21.errors : vErrors.concat(validate21.errors);
                    errors = vErrors.length;
                  }
                }
              } else {
                const err75 = { instancePath: instancePath + "/deliverables/" + i6 + "/outline", schemaPath: "#/properties/deliverables/items/properties/outline/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err75];
                } else {
                  vErrors.push(err75);
                }
                errors++;
              }
            }
            if (data25.uses !== void 0) {
              let data31 = data25.uses;
              if (Array.isArray(data31)) {
                const len8 = data31.length;
                for (let i8 = 0; i8 < len8; i8++) {
                  let data32 = data31[i8];
                  if (typeof data32 === "string") {
                    if (!pattern4.test(data32)) {
                      const err76 = { instancePath: instancePath + "/deliverables/" + i6 + "/uses/" + i8, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err76];
                      } else {
                        vErrors.push(err76);
                      }
                      errors++;
                    }
                  } else {
                    const err77 = { instancePath: instancePath + "/deliverables/" + i6 + "/uses/" + i8, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err77];
                    } else {
                      vErrors.push(err77);
                    }
                    errors++;
                  }
                }
              } else {
                const err78 = { instancePath: instancePath + "/deliverables/" + i6 + "/uses", schemaPath: "#/properties/deliverables/items/properties/uses/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err78];
                } else {
                  vErrors.push(err78);
                }
                errors++;
              }
            }
            if (data25.view !== void 0) {
              if (!validate23(data25.view, { instancePath: instancePath + "/deliverables/" + i6 + "/view", parentData: data25, parentDataProperty: "view", rootData, dynamicAnchors })) {
                vErrors = vErrors === null ? validate23.errors : vErrors.concat(validate23.errors);
                errors = vErrors.length;
              }
            }
          } else {
            const err79 = { instancePath: instancePath + "/deliverables/" + i6, schemaPath: "#/properties/deliverables/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err79];
            } else {
              vErrors.push(err79);
            }
            errors++;
          }
        }
      } else {
        const err80 = { instancePath: instancePath + "/deliverables", schemaPath: "#/properties/deliverables/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err80];
        } else {
          vErrors.push(err80);
        }
        errors++;
      }
    }
    if (data.items !== void 0) {
      let data34 = data.items;
      if (Array.isArray(data34)) {
        const len9 = data34.length;
        for (let i9 = 0; i9 < len9; i9++) {
          let data35 = data34[i9];
          if (data35 && typeof data35 == "object" && !Array.isArray(data35)) {
            if (data35.id === void 0) {
              const err81 = { instancePath: instancePath + "/items/" + i9, schemaPath: "#/properties/items/items/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err81];
              } else {
                vErrors.push(err81);
              }
              errors++;
            }
            if (data35.name === void 0) {
              const err82 = { instancePath: instancePath + "/items/" + i9, schemaPath: "#/properties/items/items/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
              if (vErrors === null) {
                vErrors = [err82];
              } else {
                vErrors.push(err82);
              }
              errors++;
            }
            if (data35.idForm === void 0) {
              const err83 = { instancePath: instancePath + "/items/" + i9, schemaPath: "#/properties/items/items/required", keyword: "required", params: { missingProperty: "idForm" }, message: "must have required property 'idForm'" };
              if (vErrors === null) {
                vErrors = [err83];
              } else {
                vErrors.push(err83);
              }
              errors++;
            }
            for (const key4 in data35) {
              if (!(key4 === "id" || key4 === "name" || key4 === "idForm" || key4 === "parent")) {
                const err84 = { instancePath: instancePath + "/items/" + i9, schemaPath: "#/properties/items/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key4 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err84];
                } else {
                  vErrors.push(err84);
                }
                errors++;
              }
            }
            if (data35.id !== void 0) {
              let data36 = data35.id;
              if (typeof data36 === "string") {
                if (!pattern4.test(data36)) {
                  const err85 = { instancePath: instancePath + "/items/" + i9 + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err85];
                  } else {
                    vErrors.push(err85);
                  }
                  errors++;
                }
              } else {
                const err86 = { instancePath: instancePath + "/items/" + i9 + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err86];
                } else {
                  vErrors.push(err86);
                }
                errors++;
              }
            }
            if (data35.name !== void 0) {
              let data37 = data35.name;
              if (typeof data37 === "string") {
                if (func2(data37) < 1) {
                  const err87 = { instancePath: instancePath + "/items/" + i9 + "/name", schemaPath: "#/properties/items/items/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err87];
                  } else {
                    vErrors.push(err87);
                  }
                  errors++;
                }
              } else {
                const err88 = { instancePath: instancePath + "/items/" + i9 + "/name", schemaPath: "#/properties/items/items/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err88];
                } else {
                  vErrors.push(err88);
                }
                errors++;
              }
            }
            if (data35.idForm !== void 0) {
              if (typeof data35.idForm !== "string") {
                const err89 = { instancePath: instancePath + "/items/" + i9 + "/idForm", schemaPath: "#/properties/items/items/properties/idForm/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err89];
                } else {
                  vErrors.push(err89);
                }
                errors++;
              }
            }
            if (data35.parent !== void 0) {
              let data39 = data35.parent;
              if (typeof data39 === "string") {
                if (!pattern4.test(data39)) {
                  const err90 = { instancePath: instancePath + "/items/" + i9 + "/parent", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err90];
                  } else {
                    vErrors.push(err90);
                  }
                  errors++;
                }
              } else {
                const err91 = { instancePath: instancePath + "/items/" + i9 + "/parent", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err91];
                } else {
                  vErrors.push(err91);
                }
                errors++;
              }
            }
          } else {
            const err92 = { instancePath: instancePath + "/items/" + i9, schemaPath: "#/properties/items/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err92];
            } else {
              vErrors.push(err92);
            }
            errors++;
          }
        }
      } else {
        const err93 = { instancePath: instancePath + "/items", schemaPath: "#/properties/items/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err93];
        } else {
          vErrors.push(err93);
        }
        errors++;
      }
    }
    if (data.rules !== void 0) {
      let data40 = data.rules;
      if (Array.isArray(data40)) {
        const len10 = data40.length;
        for (let i10 = 0; i10 < len10; i10++) {
          let data41 = data40[i10];
          if (data41 && typeof data41 == "object" && !Array.isArray(data41)) {
            if (data41.id === void 0) {
              const err94 = { instancePath: instancePath + "/rules/" + i10, schemaPath: "#/properties/rules/items/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err94];
              } else {
                vErrors.push(err94);
              }
              errors++;
            }
            if (data41.type === void 0) {
              const err95 = { instancePath: instancePath + "/rules/" + i10, schemaPath: "#/properties/rules/items/required", keyword: "required", params: { missingProperty: "type" }, message: "must have required property 'type'" };
              if (vErrors === null) {
                vErrors = [err95];
              } else {
                vErrors.push(err95);
              }
              errors++;
            }
            for (const key5 in data41) {
              if (!(key5 === "id" || key5 === "type" || key5 === "from" || key5 === "to" || key5 === "min" || key5 === "of" || key5 === "by" || key5 === "exempt")) {
                const err96 = { instancePath: instancePath + "/rules/" + i10, schemaPath: "#/properties/rules/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key5 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err96];
                } else {
                  vErrors.push(err96);
                }
                errors++;
              }
            }
            if (data41.id !== void 0) {
              let data42 = data41.id;
              if (typeof data42 === "string") {
                if (!pattern4.test(data42)) {
                  const err97 = { instancePath: instancePath + "/rules/" + i10 + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err97];
                  } else {
                    vErrors.push(err97);
                  }
                  errors++;
                }
              } else {
                const err98 = { instancePath: instancePath + "/rules/" + i10 + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err98];
                } else {
                  vErrors.push(err98);
                }
                errors++;
              }
            }
            if (data41.type !== void 0) {
              let data43 = data41.type;
              if (!(data43 === "cites" || data43 === "covered")) {
                const err99 = { instancePath: instancePath + "/rules/" + i10 + "/type", schemaPath: "#/properties/rules/items/properties/type/enum", keyword: "enum", params: { allowedValues: schema31.properties.rules.items.properties.type.enum }, message: "must be equal to one of the allowed values" };
                if (vErrors === null) {
                  vErrors = [err99];
                } else {
                  vErrors.push(err99);
                }
                errors++;
              }
            }
            if (data41.from !== void 0) {
              let data44 = data41.from;
              if (typeof data44 === "string") {
                if (!pattern4.test(data44)) {
                  const err100 = { instancePath: instancePath + "/rules/" + i10 + "/from", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err100];
                  } else {
                    vErrors.push(err100);
                  }
                  errors++;
                }
              } else {
                const err101 = { instancePath: instancePath + "/rules/" + i10 + "/from", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err101];
                } else {
                  vErrors.push(err101);
                }
                errors++;
              }
            }
            if (data41.to !== void 0) {
              let data45 = data41.to;
              if (Array.isArray(data45)) {
                const len11 = data45.length;
                for (let i11 = 0; i11 < len11; i11++) {
                  let data46 = data45[i11];
                  if (typeof data46 === "string") {
                    if (!pattern4.test(data46)) {
                      const err102 = { instancePath: instancePath + "/rules/" + i10 + "/to/" + i11, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err102];
                      } else {
                        vErrors.push(err102);
                      }
                      errors++;
                    }
                  } else {
                    const err103 = { instancePath: instancePath + "/rules/" + i10 + "/to/" + i11, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err103];
                    } else {
                      vErrors.push(err103);
                    }
                    errors++;
                  }
                }
              } else {
                const err104 = { instancePath: instancePath + "/rules/" + i10 + "/to", schemaPath: "#/properties/rules/items/properties/to/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err104];
                } else {
                  vErrors.push(err104);
                }
                errors++;
              }
            }
            if (data41.min !== void 0) {
              let data47 = data41.min;
              if (!(typeof data47 == "number" && (!(data47 % 1) && !isNaN(data47)))) {
                const err105 = { instancePath: instancePath + "/rules/" + i10 + "/min", schemaPath: "#/properties/rules/items/properties/min/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                if (vErrors === null) {
                  vErrors = [err105];
                } else {
                  vErrors.push(err105);
                }
                errors++;
              }
              if (typeof data47 == "number") {
                if (data47 < 0 || isNaN(data47)) {
                  const err106 = { instancePath: instancePath + "/rules/" + i10 + "/min", schemaPath: "#/properties/rules/items/properties/min/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                  if (vErrors === null) {
                    vErrors = [err106];
                  } else {
                    vErrors.push(err106);
                  }
                  errors++;
                }
              }
            }
            if (data41.of !== void 0) {
              let data48 = data41.of;
              if (typeof data48 === "string") {
                if (!pattern4.test(data48)) {
                  const err107 = { instancePath: instancePath + "/rules/" + i10 + "/of", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err107];
                  } else {
                    vErrors.push(err107);
                  }
                  errors++;
                }
              } else {
                const err108 = { instancePath: instancePath + "/rules/" + i10 + "/of", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err108];
                } else {
                  vErrors.push(err108);
                }
                errors++;
              }
            }
            if (data41.by !== void 0) {
              let data49 = data41.by;
              if (Array.isArray(data49)) {
                const len12 = data49.length;
                for (let i12 = 0; i12 < len12; i12++) {
                  let data50 = data49[i12];
                  if (typeof data50 === "string") {
                    if (!pattern4.test(data50)) {
                      const err109 = { instancePath: instancePath + "/rules/" + i10 + "/by/" + i12, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err109];
                      } else {
                        vErrors.push(err109);
                      }
                      errors++;
                    }
                  } else {
                    const err110 = { instancePath: instancePath + "/rules/" + i10 + "/by/" + i12, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err110];
                    } else {
                      vErrors.push(err110);
                    }
                    errors++;
                  }
                }
              } else {
                const err111 = { instancePath: instancePath + "/rules/" + i10 + "/by", schemaPath: "#/properties/rules/items/properties/by/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err111];
                } else {
                  vErrors.push(err111);
                }
                errors++;
              }
            }
            if (data41.exempt !== void 0) {
              if (true !== data41.exempt) {
                const err112 = { instancePath: instancePath + "/rules/" + i10 + "/exempt", schemaPath: "#/properties/rules/items/properties/exempt/const", keyword: "const", params: { allowedValue: true }, message: "must be equal to constant" };
                if (vErrors === null) {
                  vErrors = [err112];
                } else {
                  vErrors.push(err112);
                }
                errors++;
              }
            }
          } else {
            const err113 = { instancePath: instancePath + "/rules/" + i10, schemaPath: "#/properties/rules/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err113];
            } else {
              vErrors.push(err113);
            }
            errors++;
          }
        }
      } else {
        const err114 = { instancePath: instancePath + "/rules", schemaPath: "#/properties/rules/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err114];
        } else {
          vErrors.push(err114);
        }
        errors++;
      }
    }
    if (data.strictCites !== void 0) {
      if (true !== data.strictCites) {
        const err115 = { instancePath: instancePath + "/strictCites", schemaPath: "#/properties/strictCites/const", keyword: "const", params: { allowedValue: true }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err115];
        } else {
          vErrors.push(err115);
        }
        errors++;
      }
    }
    if (data.roles !== void 0) {
      let data53 = data.roles;
      if (Array.isArray(data53)) {
        const len13 = data53.length;
        for (let i13 = 0; i13 < len13; i13++) {
          let data54 = data53[i13];
          if (data54 && typeof data54 == "object" && !Array.isArray(data54)) {
            if (data54.id === void 0) {
              const err116 = { instancePath: instancePath + "/roles/" + i13, schemaPath: "#/properties/roles/items/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err116];
              } else {
                vErrors.push(err116);
              }
              errors++;
            }
            if (data54.name === void 0) {
              const err117 = { instancePath: instancePath + "/roles/" + i13, schemaPath: "#/properties/roles/items/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
              if (vErrors === null) {
                vErrors = [err117];
              } else {
                vErrors.push(err117);
              }
              errors++;
            }
            for (const key6 in data54) {
              if (!(key6 === "id" || key6 === "name" || key6 === "text")) {
                const err118 = { instancePath: instancePath + "/roles/" + i13, schemaPath: "#/properties/roles/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key6 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err118];
                } else {
                  vErrors.push(err118);
                }
                errors++;
              }
            }
            if (data54.id !== void 0) {
              let data55 = data54.id;
              if (typeof data55 === "string") {
                if (!pattern4.test(data55)) {
                  const err119 = { instancePath: instancePath + "/roles/" + i13 + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err119];
                  } else {
                    vErrors.push(err119);
                  }
                  errors++;
                }
              } else {
                const err120 = { instancePath: instancePath + "/roles/" + i13 + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err120];
                } else {
                  vErrors.push(err120);
                }
                errors++;
              }
            }
            if (data54.name !== void 0) {
              let data56 = data54.name;
              if (typeof data56 === "string") {
                if (func2(data56) < 1) {
                  const err121 = { instancePath: instancePath + "/roles/" + i13 + "/name", schemaPath: "#/properties/roles/items/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err121];
                  } else {
                    vErrors.push(err121);
                  }
                  errors++;
                }
              } else {
                const err122 = { instancePath: instancePath + "/roles/" + i13 + "/name", schemaPath: "#/properties/roles/items/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err122];
                } else {
                  vErrors.push(err122);
                }
                errors++;
              }
            }
            if (data54.text !== void 0) {
              let data57 = data54.text;
              if (typeof data57 === "string") {
                if (func2(data57) < 1) {
                  const err123 = { instancePath: instancePath + "/roles/" + i13 + "/text", schemaPath: "#/properties/roles/items/properties/text/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err123];
                  } else {
                    vErrors.push(err123);
                  }
                  errors++;
                }
              } else {
                const err124 = { instancePath: instancePath + "/roles/" + i13 + "/text", schemaPath: "#/properties/roles/items/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err124];
                } else {
                  vErrors.push(err124);
                }
                errors++;
              }
            }
          } else {
            const err125 = { instancePath: instancePath + "/roles/" + i13, schemaPath: "#/properties/roles/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err125];
            } else {
              vErrors.push(err125);
            }
            errors++;
          }
        }
      } else {
        const err126 = { instancePath: instancePath + "/roles", schemaPath: "#/properties/roles/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err126];
        } else {
          vErrors.push(err126);
        }
        errors++;
      }
    }
    if (data.acceptance !== void 0) {
      let data58 = data.acceptance;
      if (Array.isArray(data58)) {
        const len14 = data58.length;
        for (let i14 = 0; i14 < len14; i14++) {
          let data59 = data58[i14];
          if (data59 && typeof data59 == "object" && !Array.isArray(data59)) {
            if (data59.id === void 0) {
              const err127 = { instancePath: instancePath + "/acceptance/" + i14, schemaPath: "#/properties/acceptance/items/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err127];
              } else {
                vErrors.push(err127);
              }
              errors++;
            }
            if (data59.text === void 0) {
              const err128 = { instancePath: instancePath + "/acceptance/" + i14, schemaPath: "#/properties/acceptance/items/required", keyword: "required", params: { missingProperty: "text" }, message: "must have required property 'text'" };
              if (vErrors === null) {
                vErrors = [err128];
              } else {
                vErrors.push(err128);
              }
              errors++;
            }
            if (data59.checkedBy === void 0) {
              const err129 = { instancePath: instancePath + "/acceptance/" + i14, schemaPath: "#/properties/acceptance/items/required", keyword: "required", params: { missingProperty: "checkedBy" }, message: "must have required property 'checkedBy'" };
              if (vErrors === null) {
                vErrors = [err129];
              } else {
                vErrors.push(err129);
              }
              errors++;
            }
            if (data59.target === void 0) {
              const err130 = { instancePath: instancePath + "/acceptance/" + i14, schemaPath: "#/properties/acceptance/items/required", keyword: "required", params: { missingProperty: "target" }, message: "must have required property 'target'" };
              if (vErrors === null) {
                vErrors = [err130];
              } else {
                vErrors.push(err130);
              }
              errors++;
            }
            for (const key7 in data59) {
              if (!(key7 === "id" || key7 === "text" || key7 === "checkedBy" || key7 === "target" || key7 === "rules" || key7 === "approvers")) {
                const err131 = { instancePath: instancePath + "/acceptance/" + i14, schemaPath: "#/properties/acceptance/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key7 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err131];
                } else {
                  vErrors.push(err131);
                }
                errors++;
              }
            }
            if (data59.id !== void 0) {
              let data60 = data59.id;
              if (typeof data60 === "string") {
                if (!pattern4.test(data60)) {
                  const err132 = { instancePath: instancePath + "/acceptance/" + i14 + "/id", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err132];
                  } else {
                    vErrors.push(err132);
                  }
                  errors++;
                }
              } else {
                const err133 = { instancePath: instancePath + "/acceptance/" + i14 + "/id", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err133];
                } else {
                  vErrors.push(err133);
                }
                errors++;
              }
            }
            if (data59.text !== void 0) {
              let data61 = data59.text;
              if (typeof data61 === "string") {
                if (func2(data61) < 1) {
                  const err134 = { instancePath: instancePath + "/acceptance/" + i14 + "/text", schemaPath: "#/properties/acceptance/items/properties/text/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err134];
                  } else {
                    vErrors.push(err134);
                  }
                  errors++;
                }
              } else {
                const err135 = { instancePath: instancePath + "/acceptance/" + i14 + "/text", schemaPath: "#/properties/acceptance/items/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err135];
                } else {
                  vErrors.push(err135);
                }
                errors++;
              }
            }
            if (data59.checkedBy !== void 0) {
              let data62 = data59.checkedBy;
              if (!(data62 === "\u4EBA" || data62 === "AI")) {
                const err136 = { instancePath: instancePath + "/acceptance/" + i14 + "/checkedBy", schemaPath: "#/properties/acceptance/items/properties/checkedBy/enum", keyword: "enum", params: { allowedValues: schema31.properties.acceptance.items.properties.checkedBy.enum }, message: "must be equal to one of the allowed values" };
                if (vErrors === null) {
                  vErrors = [err136];
                } else {
                  vErrors.push(err136);
                }
                errors++;
              }
            }
            if (data59.target !== void 0) {
              let data63 = data59.target;
              if (typeof data63 === "string") {
                if (!pattern4.test(data63)) {
                  const err137 = { instancePath: instancePath + "/acceptance/" + i14 + "/target", schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                  if (vErrors === null) {
                    vErrors = [err137];
                  } else {
                    vErrors.push(err137);
                  }
                  errors++;
                }
              } else {
                const err138 = { instancePath: instancePath + "/acceptance/" + i14 + "/target", schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err138];
                } else {
                  vErrors.push(err138);
                }
                errors++;
              }
            }
            if (data59.rules !== void 0) {
              let data64 = data59.rules;
              if (Array.isArray(data64)) {
                const len15 = data64.length;
                for (let i15 = 0; i15 < len15; i15++) {
                  let data65 = data64[i15];
                  if (typeof data65 === "string") {
                    if (!pattern4.test(data65)) {
                      const err139 = { instancePath: instancePath + "/acceptance/" + i14 + "/rules/" + i15, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                      if (vErrors === null) {
                        vErrors = [err139];
                      } else {
                        vErrors.push(err139);
                      }
                      errors++;
                    }
                  } else {
                    const err140 = { instancePath: instancePath + "/acceptance/" + i14 + "/rules/" + i15, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err140];
                    } else {
                      vErrors.push(err140);
                    }
                    errors++;
                  }
                }
              } else {
                const err141 = { instancePath: instancePath + "/acceptance/" + i14 + "/rules", schemaPath: "#/properties/acceptance/items/properties/rules/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err141];
                } else {
                  vErrors.push(err141);
                }
                errors++;
              }
            }
            if (data59.approvers !== void 0) {
              let data66 = data59.approvers;
              if (data66 && typeof data66 == "object" && !Array.isArray(data66)) {
                if (data66.roles === void 0) {
                  const err142 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers", schemaPath: "#/properties/acceptance/items/properties/approvers/required", keyword: "required", params: { missingProperty: "roles" }, message: "must have required property 'roles'" };
                  if (vErrors === null) {
                    vErrors = [err142];
                  } else {
                    vErrors.push(err142);
                  }
                  errors++;
                }
                for (const key8 in data66) {
                  if (!(key8 === "roles" || key8 === "count")) {
                    const err143 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers", schemaPath: "#/properties/acceptance/items/properties/approvers/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key8 }, message: "must NOT have additional properties" };
                    if (vErrors === null) {
                      vErrors = [err143];
                    } else {
                      vErrors.push(err143);
                    }
                    errors++;
                  }
                }
                if (data66.roles !== void 0) {
                  let data67 = data66.roles;
                  if (Array.isArray(data67)) {
                    if (data67.length < 1) {
                      const err144 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers/roles", schemaPath: "#/properties/acceptance/items/properties/approvers/properties/roles/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
                      if (vErrors === null) {
                        vErrors = [err144];
                      } else {
                        vErrors.push(err144);
                      }
                      errors++;
                    }
                    const len16 = data67.length;
                    for (let i16 = 0; i16 < len16; i16++) {
                      let data68 = data67[i16];
                      if (typeof data68 === "string") {
                        if (!pattern4.test(data68)) {
                          const err145 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers/roles/" + i16, schemaPath: "#/$defs/id/pattern", keyword: "pattern", params: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$" }, message: 'must match pattern "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$"' };
                          if (vErrors === null) {
                            vErrors = [err145];
                          } else {
                            vErrors.push(err145);
                          }
                          errors++;
                        }
                      } else {
                        const err146 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers/roles/" + i16, schemaPath: "#/$defs/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                        if (vErrors === null) {
                          vErrors = [err146];
                        } else {
                          vErrors.push(err146);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err147 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers/roles", schemaPath: "#/properties/acceptance/items/properties/approvers/properties/roles/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                    if (vErrors === null) {
                      vErrors = [err147];
                    } else {
                      vErrors.push(err147);
                    }
                    errors++;
                  }
                }
                if (data66.count !== void 0) {
                  let data69 = data66.count;
                  if (!(typeof data69 == "number" && (!(data69 % 1) && !isNaN(data69)))) {
                    const err148 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers/count", schemaPath: "#/properties/acceptance/items/properties/approvers/properties/count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                    if (vErrors === null) {
                      vErrors = [err148];
                    } else {
                      vErrors.push(err148);
                    }
                    errors++;
                  }
                  if (typeof data69 == "number") {
                    if (data69 < 1 || isNaN(data69)) {
                      const err149 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers/count", schemaPath: "#/properties/acceptance/items/properties/approvers/properties/count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
                      if (vErrors === null) {
                        vErrors = [err149];
                      } else {
                        vErrors.push(err149);
                      }
                      errors++;
                    }
                  }
                }
              } else {
                const err150 = { instancePath: instancePath + "/acceptance/" + i14 + "/approvers", schemaPath: "#/properties/acceptance/items/properties/approvers/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                if (vErrors === null) {
                  vErrors = [err150];
                } else {
                  vErrors.push(err150);
                }
                errors++;
              }
            }
          } else {
            const err151 = { instancePath: instancePath + "/acceptance/" + i14, schemaPath: "#/properties/acceptance/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err151];
            } else {
              vErrors.push(err151);
            }
            errors++;
          }
        }
      } else {
        const err152 = { instancePath: instancePath + "/acceptance", schemaPath: "#/properties/acceptance/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err152];
        } else {
          vErrors.push(err152);
        }
        errors++;
      }
    }
    if (data.gates !== void 0) {
      let data70 = data.gates;
      if (Array.isArray(data70)) {
        const len17 = data70.length;
        for (let i17 = 0; i17 < len17; i17++) {
          if (!validate42(data70[i17], { instancePath: instancePath + "/gates/" + i17, parentData: data70, parentDataProperty: i17, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate42.errors : vErrors.concat(validate42.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err153 = { instancePath: instancePath + "/gates", schemaPath: "#/properties/gates/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err153];
        } else {
          vErrors.push(err153);
        }
        errors++;
      }
    }
    if (data.placements !== void 0) {
      let data72 = data.placements;
      if (Array.isArray(data72)) {
        if (data72.length < 1) {
          const err154 = { instancePath: instancePath + "/placements", schemaPath: "#/properties/placements/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err154];
          } else {
            vErrors.push(err154);
          }
          errors++;
        }
        const len18 = data72.length;
        for (let i18 = 0; i18 < len18; i18++) {
          if (!validate44(data72[i18], { instancePath: instancePath + "/placements/" + i18, parentData: data72, parentDataProperty: i18, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate44.errors : vErrors.concat(validate44.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err155 = { instancePath: instancePath + "/placements", schemaPath: "#/properties/placements/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err155];
        } else {
          vErrors.push(err155);
        }
        errors++;
      }
    }
  } else {
    const err156 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err156];
    } else {
      vErrors.push(err156);
    }
    errors++;
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
export {
  validate
};
