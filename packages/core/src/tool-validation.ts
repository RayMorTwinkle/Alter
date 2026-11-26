import { compile, type ValidationError, type Validator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { ToolRegistration } from "./runtime.ts";

type SchemaObject = Record<string, unknown>;
const record = (value: unknown): SchemaObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as SchemaObject : undefined;
const own = (obj: SchemaObject | undefined, key: string) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined;
const segments = (pointer: string) => pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
const quoted = (key: string) => JSON.stringify(key);
const composed = ["$ref", "$dynamicRef", "allOf", "anyOf", "oneOf", "if", "dependentSchemas", "dependencies"];
const fieldPath = (keys: string[]) => keys.reduce((path, key) =>
  /^\d+$/.test(key) ? path + "[" + key + "]" :
    /^[\w$-]+$/.test(key) ? (path ? path + "." : "") + key : path + "[" + quoted(key) + "]", "") || "root";

function reference(root: SchemaObject, ref: unknown) {
  if (ref === "#") return root;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return;
  let pointer: string;
  try { pointer = decodeURIComponent(ref.slice(1)); } catch { return; }
  let target: unknown = root;
  for (const key of segments(pointer)) {
    target = Array.isArray(target) ? target[Number(key)] : own(record(target), key);
  }
  return target;
}

// These subschemas describe the same value, not its children. In particular, allOf and
// $ref siblings can declare fields separately and must not close each other out.
function* layers(root: SchemaObject, node: unknown, seen = new Set<SchemaObject>()): Generator<SchemaObject> {
  const schema = record(node);
  if (!schema || seen.has(schema)) return;
  seen.add(schema);
  yield schema;
  yield* layers(root, reference(root, schema.$ref), seen);
  for (const key of ["allOf", "anyOf", "oneOf", "then", "else"]) {
    const children = schema[key];
    for (const child of Array.isArray(children) ? children : [children]) yield* layers(root, child, seen);
  }
}

function closeObjects(root: SchemaObject) {
  function visit(value: unknown, boundary: boolean, alternative = false): unknown {
    const node = record(value);
    if (!node) return value;
    const copy = { ...node };
    // On a local shape, additionalProperties reports typos even when required fields
    // are also missing. Composed shapes close over all evaluated fields at this boundary.
    if (boundary && node.unevaluatedProperties === undefined) {
      if (record(node.properties) && node.additionalProperties === undefined && !composed.some(key => node[key] !== undefined)) {
        copy.additionalProperties = false;
      } else if ([...layers(root, node)].some(layer => record(layer.properties) && layer.additionalProperties === undefined)) {
        copy.unevaluatedProperties = false;
      }
    }
    // An explicit free-form object alternative is allowed to accept the entire object.
    if (alternative && node.type === "object" && node.properties === undefined && node.patternProperties === undefined &&
        node.additionalProperties === undefined && node.unevaluatedProperties === undefined &&
        ![...layers(root, node)].some(layer => layer.properties !== undefined || layer.patternProperties !== undefined ||
          layer.additionalProperties !== undefined || layer.unevaluatedProperties !== undefined)) {
      copy.additionalProperties = true;
    }
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
      const children = record(node[key]);
      if (children) copy[key] = Object.fromEntries(Object.entries(children).map(([name, child]) =>
        [name, visit(child, key === "properties" || key === "patternProperties")]));
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems", "items"]) {
      const children = node[key];
      if (Array.isArray(children)) copy[key] = children.map(child => visit(child, key === "items" || key === "prefixItems", key === "anyOf" || key === "oneOf"));
    }
    for (const key of ["items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "propertyNames",
      "not", "if", "then", "else"]) {
      if (record(node[key])) copy[key] = visit(node[key], !["not", "if", "then", "else"].includes(key));
    }
    return copy;
  }
  const result = visit(root, true) as SchemaObject;
  if (result.type === undefined && (result.properties !== undefined || result.patternProperties !== undefined || result.required !== undefined)) {
    result.type = "object";
  }
  return result;
}

function matchesPattern(pattern: string, key: string) {
  // pi-schema retries without the Unicode flag for legacy escaped patterns.
  try { return new RegExp(pattern, "u").test(key); }
  catch { return new RegExp(pattern).test(key); }
}

function allowedFields(root: SchemaObject, parent: string[]) {
  let nodes: unknown[] = [root];
  for (const key of parent) {
    nodes = nodes.flatMap(node => [...layers(root, node)].flatMap(schema => {
      const property = own(record(schema.properties), key);
      const patterns = Object.entries(record(schema.patternProperties) ?? {}).filter(([pattern]) => matchesPattern(pattern, key));
      const item = /^\d+$/.test(key) ?
        (Array.isArray(schema.items) ? schema.items[Number(key)] ?? schema.additionalItems :
          (Array.isArray(schema.prefixItems) ? schema.prefixItems[Number(key)] : undefined) ?? schema.items) : undefined;
      return [property, ...patterns.map(([, child]) => child), item,
        ...(property === undefined && !patterns.length ? [schema.additionalProperties] : [])];
    })).filter(node => record(node));
  }
  const at = nodes.flatMap(node => [...layers(root, node)]);
  const names = [...new Set(at.flatMap(node => Object.keys(record(node.properties) ?? {})))].map(quoted);
  const patterns = [...new Set(at.flatMap(node => Object.keys(record(node.patternProperties) ?? {})))];
  return [names.length ? names.join(", ") : "none", ...patterns.map(pattern => "or a key matching " + quoted(pattern))].join(" ");
}

function explain(schema: SchemaObject, error: ValidationError, value: unknown) {
  const keys = error.path ? segments(error.path) : [];
  const path = fieldPath(keys);
  switch (error.keyword) {
    case "required": return "missing required argument " + quoted(path);
    case "additionalProperties":
    case "unevaluatedProperties": return "unknown argument " + quoted(path) + " (allowed properties: " + allowedFields(schema, keys.slice(0, -1)) + ")";
    case "enum":
    case "const":
    case "anyOf":
    case "oneOf": {
      const at = keys.reduce<unknown>((node, key) => Array.isArray(node) ? node[Number(key)] : own(record(node), key), value);
      return quoted(path) + ": " + error.message + (at === null ? ", got null" : "");
    }
    default: return quoted(path) + ": " + error.message;
  }
}

// Undefined object fields are absent in JSON, including for unconstrained required properties.
// Reject class instances and other non-JSON values before the schema library (or the harness) sees them.
function jsonInput(value: unknown, path: string[], ancestors = new Set<object>()): unknown {
  const fail = (reason: string): never => { throw new Error(quoted(fieldPath(path)) + ": " + reason); };
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) return fail("expected a JSON value");
  if (ancestors.has(value)) return fail("expected a JSON value without circular references");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (item, index) => jsonInput(item, [...path, String(index)], ancestors));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return fail("expected a plain object");
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, jsonInput(item, [...path, key], ancestors)]]));
  } finally { ancestors.delete(value); }
}

const validators = new WeakMap<object, Validator>();
/** Return field-level feedback without coercing values or changing the offered schema. */
export function toolArgumentError(parameters: object, args: unknown): string | undefined {
  const schema = parameters as SchemaObject;
  let input: unknown;
  try { input = jsonInput(args, []); }
  catch (error) { return (error as Error).message; }
  let validator = validators.get(schema);
  if (!validator) {
    validator = compile(closeObjects(schema), { formats, unresolvedRefs: "reject" });
    validators.set(schema, validator);
  }
  const result = validator.validate(input);
  if (!result.ok) return [...new Set(result.errors.map(error => explain(schema, error, input)))].join("; ");
}

const strict = new WeakSet<ToolRegistration>();
/** Validate raw input and any existing preparation result before the harness can coerce either. */
export function withStrictToolArguments<T extends ToolRegistration>(
  tool: T, rule?: (args: Parameters<T["execute"]>[0]) => string | undefined,
): T {
  if (!rule && strict.has(tool)) return tool;
  function check(args: unknown, conditional: boolean) {
    const error = toolArgumentError(tool.parameters, args) ?? (conditional ? rule?.(args as Parameters<T["execute"]>[0]) : undefined);
    if (error) throw new Error("Invalid arguments for tool " + quoted(tool.name) + ": " + error);
  }
  const wrapped = { ...tool, prepareArguments(args: unknown) {
    if (!tool.prepareArguments) {
      check(args, true);
      return args;
    }
    check(args, false);
    const prepared = tool.prepareArguments(args);
    check(prepared, true);
    return prepared;
  } };
  strict.add(wrapped);
  return wrapped;
}

export function missingArguments<T extends object>(args: T, keys: readonly (keyof T & string)[], when: string) {
  const missing = keys.filter(key => !Object.hasOwn(args, key) || args[key] === undefined).map(quoted);
  if (missing.length) return "missing required argument" + (missing.length === 1 ? " " : "s ") + missing.join(" and ") + " " + when;
}

export function hasArgument<T extends object>(args: T, keys: readonly (keyof T & string)[]) {
  return keys.some(key => Object.hasOwn(args, key) && args[key] !== undefined);
}
