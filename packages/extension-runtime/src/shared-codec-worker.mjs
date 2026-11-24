// A dedicated child owns the WASM engine. Every transaction gets an empty runtime and heap.
import { getQuickJS } from 'quickjs-emscripten';
import process from 'node:process';

const engine = await getQuickJS();
// This function is compiled as the trusted driver in QuickJS; its only input is copied JSON.
function transaction(api, request) {
  const call = (method, ...args) =>
    api[method](...args.map((value) => JSON.parse(JSON.stringify(value))));
  if (request.mode === 'anchor')
    return JSON.stringify({
      exists:
        !!api.validateAnchor && call('validateAnchor', request.content, request.target) === true,
    });
  if (request.mode === 'validate' || request.mode === 'migrate') {
    const content =
      request.mode === 'validate'
        ? request.content
        : call('migrate', request.from, request.content);
    if (call('validate', content) !== true) throw Error('Invalid document');
    return JSON.stringify({ content });
  }
  const { declaration, input, base, current } = request;
  if (call('validate', base) !== true || call('validate', current) !== true)
    throw Error('Invalid document');
  if (!request.inverse && api.checkInput && call('checkInput', declaration.id, input, base).length)
    throw Error('invalid-operation');
  const validAction = (a) =>
    a &&
    typeof a.type === 'string' &&
    typeof a.target === 'string' &&
    a.payload !== null &&
    typeof a.payload === 'object' &&
    !Array.isArray(a.payload);
  const actions = request.inverse ?? call('plan', declaration.id, declaration.version, input, base);
  if (
    !Array.isArray(actions) ||
    !actions.length ||
    actions.length > 500 ||
    !actions.every(validAction)
  )
    throw Error('Invalid action count');
  function apply(content) {
    const required = new Set(),
      targets = new Set(),
      touched = new Set(),
      inverse = [];
    for (const action of actions) {
      const effect = call('apply', content, action);
      for (const [values, keys] of [
        [effect.required, required],
        [effect.targets, targets],
        [effect.touched, touched],
      ]) {
        if (
          !Array.isArray(values) ||
          !values.length ||
          values.length > 1000 ||
          !values.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 256)
        )
          throw Error('Invalid codec resources');
        for (const key of values) keys.add(key);
      }
      if (
        !Array.isArray(effect.inverse) ||
        !effect.inverse.length ||
        !effect.inverse.every(validAction)
      )
        throw Error('Missing inverse');
      inverse.unshift(...effect.inverse);
      content = effect.content;
    }
    if (call('validate', content) !== true) throw Error('Invalid result');
    return {
      content,
      required: [...required].sort(),
      targets: [...targets].sort(),
      touched: [...touched],
      inverse,
    };
  }
  const expected = apply(base);
  const result = apply(current);
  const resources = (content, keys) => keys.map((key) => call('resource', content, key));
  return JSON.stringify({
    expected: expected.required,
    expectedTargets: expected.targets,
    result,
    before: resources(base, expected.required),
    now: resources(current, result.required),
  });
}

function evaluate(source, request) {
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const vm = runtime.newContext({
    intrinsics: {
      BaseObjects: true,
      Promise: true,
      Eval: true,
      JSON: true,
      MapSet: true,
      RegExp: true,
      RegExpCompiler: true,
    },
  });
  let started = (process.threadCpuUsage ?? process.cpuUsage)();
  function exhausted() {
    const cpu = (process.threadCpuUsage ?? process.cpuUsage)(started);
    return cpu.user + cpu.system > 50_000;
  }
  runtime.setInterruptHandler(exhausted);
  function take(result) {
    if (result.error) {
      const exception = vm.dump(result.error);
      result.error.dispose();
      if (['target-deleted', 'stale-precondition', 'undo-conflict'].includes(exception?.message)) {
        throw Error(exception.message);
      }
      throw Error('Codec execution failed');
    }
    return result.value;
  }

  try {
    take(
      vm.evalCode(`
    delete Math.random;
    delete String.prototype.localeCompare;
    for (const proto of [String.prototype, Array.prototype, Number.prototype, Object.prototype])
      for (const key of Object.getOwnPropertyNames(proto))
        if (key.includes('Locale')) delete proto[key];
    delete globalThis.eval;
    for (const fn of [function(){}, function*(){}, async function(){}, async function*(){}])
      delete Object.getPrototypeOf(fn).constructor;
    delete globalThis.Function;
  `),
    ).dispose();
    runtime.setModuleLoader((name) => {
      if (name !== 'codec') throw Error('External module');
      return source;
    });
    const program = `import * as codec from 'codec'; export const output = (${transaction.toString()})(codec,JSON.parse(${JSON.stringify(JSON.stringify(request))}));`;
    started = (process.threadCpuUsage ?? process.cpuUsage)();
    const api = take(vm.evalCode(program, 'transaction.mjs', { type: 'module' }));
    try {
      const value = vm.getProp(api, 'output');
      try {
        if (vm.typeof(value) !== 'string') throw Error('Invalid codec result');
        const output = vm.getString(value);
        if (exhausted() || output.length > 1_000_000) throw Error('Codec budget exceeded');
        return output;
      } finally {
        value.dispose();
      }
    } finally {
      api.dispose();
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
process.on('message', ({ source, request }) => {
  try {
    process.send({ output: evaluate(source, request) });
  } catch (error) {
    process.send({
      code: ['target-deleted', 'stale-precondition', 'undo-conflict'].includes(error.message)
        ? error.message
        : 'invalid-operation',
    });
  }
});
process.on('disconnect', () => process.exit(0));
