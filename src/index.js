const traverseModule = require('@babel/traverse');

/** CJS interop: some bundlers expose `default` on `.default`. */
const traverse = traverseModule.default ?? traverseModule;

/** `return ( <jsx/> );` is often wrapped in ParenthesizedExpression — unwrap before checking. */
const unwrapExpression = (t, node) => {
  let a = node;
  while (t.isParenthesizedExpression(a)) a = a.expression;
  return a;
};

/** Mettle calls the component return value as `template()` — must be a plain function/arrow thunk. */
const isThunkFunctionExpression = (t, node) => {
  const bare = unwrapExpression(t, node);
  return t.isArrowFunctionExpression(bare) || t.isFunctionExpression(bare);
};

/** @param {import('@babel/types').Statement[]} body */
const isMettleComponentBody = (t, body) =>
  body.some((node) => {
    if (!t.isReturnStatement(node)) return false;
    const arg = unwrapExpression(t, node.argument);
    if (t.isArrowFunctionExpression(arg) || t.isJSXElement(arg) || t.isJSXFragment(arg)) {
      return true;
    }
    // babel-plugin-mettle: return function () { return <jsx />; };
    if (t.isFunctionExpression(arg)) {
      const fnBody = arg.body;
      if (t.isBlockStatement(fnBody) && fnBody.body.length === 1) {
        const only = fnBody.body[0];
        if (t.isReturnStatement(only) && only.argument) {
          const innerArg = unwrapExpression(t, only.argument);
          return t.isJSXElement(innerArg) || t.isJSXFragment(innerArg);
        }
      }
    }
    return false;
  });

/** JSX / fragment or nested function whose body is a Mettle view (for concise arrow `() => <jsx />`). */
const expressionIsMettleViewRoot = (t, expr) => {
  const arg = unwrapExpression(t, expr);
  if (t.isJSXElement(arg) || t.isJSXFragment(arg)) return true;
  if (t.isArrowFunctionExpression(arg)) {
    const b = arg.body;
    if (t.isBlockStatement(b)) return isMettleComponentBody(t, b.body);
    return expressionIsMettleViewRoot(t, b);
  }
  if (t.isFunctionExpression(arg)) {
    if (t.isBlockStatement(arg.body)) {
      return isMettleComponentBody(t, arg.body.body);
    }
    return false;
  }
  return false;
};

/** Arrow or function expression: block body or concise arrow returning a view. */
const isMettleFunctionBody = (t, fn) => {
  if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) return false;
  if (t.isBlockStatement(fn.body)) {
    return isMettleComponentBody(t, fn.body.body);
  }
  if (t.isArrowFunctionExpression(fn)) {
    return expressionIsMettleViewRoot(t, fn.body);
  }
  return false;
};

/** Whether `$signal` appears in this function Path subtree (when a Babel Path is already available). */
function fnPathHasSignalSugar(t, fnPath) {
  let found = false;
  fnPath.traverse({
    VariableDeclarator(path) {
      if (path.getFunctionParent()?.node !== fnPath.node) return;
      const init = path.node.init;
      if (
        t.isCallExpression(init) &&
        t.isIdentifier(init.callee) &&
        init.callee.name === '$signal'
      ) {
        found = true;
        path.stop();
      }
    },
  });
  return found;
}

/** @param {import('@babel/traverse').NodePath} declPath @param {import('@babel/traverse').NodePath} fnPath */
function declaratorInFunctionScope(declPath, fnPath) {
  const fp = declPath.getFunctionParent();
  return fp != null && fp.node === fnPath.node;
}

/**
 * From a hook's `return { a, b }`, find properties that overlap reactiveVars whose value is an
 * identifier with the same name (handles multiple return statements).
 * @param {import('@babel/types').Node} fnNode
 * @param {Set<string>} reactiveVarNames
 * @param {import('@babel/types').File | import('@babel/types').Program} hostAst Full AST containing fnNode
 */
const extractHookExportedReactiveKeys = (t, fnNode, reactiveVarNames, hostAst) => {
  const keys = new Set();
  if (!t.isBlockStatement(fnNode.body) || !hostAst) return keys;
  traverse(hostAst, {
    ReturnStatement(path) {
      if (path.getFunctionParent()?.node !== fnNode) return;
      const arg = path.node.argument;
      if (!arg || !t.isObjectExpression(arg)) return;
      for (const prop of arg.properties) {
        if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.key)) continue;
        const keyName = prop.key.name;
        if (!reactiveVarNames.has(keyName)) continue;
        if (prop.shorthand) {
          keys.add(keyName);
          continue;
        }
        if (t.isIdentifier(prop.value) && prop.value.name === keyName) {
          keys.add(keyName);
        }
      }
    },
  });
  return keys;
};

const pathIsStateOnlyHook = (t, fnPath) => {
  const bb = fnPath.node.body;
  return (
    t.isBlockStatement(bb) && fnPathHasSignalSugar(t, fnPath) && !isMettleComponentBody(t, bb.body)
  );
};

function appendMettleSpecifiers(t, mettleImportPath, specifiersToAdd) {
  const existing = new Set(
    mettleImportPath.node.specifiers
      .map((s) => (t.isImportSpecifier(s) ? s.local.name : s.local?.name))
      .filter(Boolean),
  );
  for (const sp of specifiersToAdd) {
    if (!existing.has(sp.local.name)) {
      mettleImportPath.node.specifiers.push(sp);
      existing.add(sp.local.name);
    }
  }
}

/** Normalize to forward slashes before matching so Windows backslashes are not missed. */
function isNodeModulesPath(p) {
  if (typeof p !== 'string' || !p) return false;
  const norm = p.replace(/\\/g, '/');
  return norm.includes('/node_modules/');
}

/**
 * @param {import('@babel/core')} api
 */
function babelPluginMettle(api) {
  const t = api.types;
  const options = {
    include: /\.(jsx|js|mjs|tsx|ts)$/,
    excludeVars: ['window', 'document', 'console', 'this'],
    restrictToTemplateReach: true,
  };

  const isJSXLike = (node) => {
    if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
    if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
      const n = node.callee.name;
      return n === '_jsx' || n === '_jsxs' || n === 'jsx' || n === 'jsxs' || n === 'jsxDEV';
    }
    return false;
  };

  function isFirstCharUpperCase(str) {
    return str && /^[A-Z]/.test(str);
  }

  /** Name used for PascalCase / Mettle component heuristics (not runtime binding). */
  function getFunctionName(path) {
    const node = path.node;
    if (t.isIdentifier(node.id)) {
      return node.id.name;
    }

    const parent = path.parent;
    if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
      return parent.id.name;
    }

    if (t.isAssignmentExpression(parent)) {
      const left = parent.left;
      if (t.isIdentifier(left)) return left.name;
      if (t.isMemberExpression(left) && !left.computed) {
        if (t.isIdentifier(left.property)) return left.property.name;
      }
      if (t.isMemberExpression(left) && left.computed && t.isStringLiteral(left.property)) {
        return left.property.value;
      }
      return null;
    }

    if (t.isProperty(parent)) {
      if (!parent.computed && t.isIdentifier(parent.key)) return parent.key.name;
      if (!parent.computed && t.isStringLiteral(parent.key)) return parent.key.value;
      if (parent.computed && t.isStringLiteral(parent.key)) return parent.key.value;
      return null;
    }

    if (t.isExportDefaultDeclaration(parent)) {
      return 'Default';
    }

    if (t.isClassMethod(parent) || t.isClassPrivateMethod(parent)) {
      const key = parent.key;
      if (t.isIdentifier(key)) return key.name;
      if (t.isStringLiteral(key)) return key.value;
      return null;
    }

    if (t.isClassProperty(parent) && !parent.computed && t.isIdentifier(parent.key)) {
      return parent.key.name;
    }

    return null;
  }

  function processMettlePascalCaseReturnWrap(path) {
    const functionName = getFunctionName(path);

    if (!isFirstCharUpperCase(functionName)) {
      return;
    }

    if (path.isArrowFunctionExpression()) {
      const bodyPath = path.get('body');
      if (bodyPath.isExpression() && !isThunkFunctionExpression(t, bodyPath.node)) {
        const raw = bodyPath.node;
        const bare = unwrapExpression(t, raw);
        if (isJSXLike(bare)) {
          path.node.body = t.blockStatement([
            t.returnStatement(
              t.functionExpression(null, [], t.blockStatement([t.returnStatement(raw)])),
            ),
          ]);
        }
      }
    }

    path.traverse({
      ReturnStatement(returnPath) {
        if (returnPath.getFunctionParent()?.node === path.node && returnPath.node.argument) {
          const argNode = returnPath.node.argument;
          if (isThunkFunctionExpression(t, argNode)) return;
          const bare = unwrapExpression(t, argNode);
          if (!isJSXLike(bare)) return;
          const newFunction = t.functionExpression(
            null,
            [],
            t.blockStatement([t.returnStatement(argNode)]),
          );
          returnPath.node.argument = newFunction;
        }
      },

      FunctionDeclaration(innerPath) {
        if (innerPath.node !== path.node) {
          processMettlePascalCaseReturnWrap(innerPath);
          innerPath.skip();
        }
      },

      FunctionExpression(innerPath) {
        if (innerPath.node !== path.node) {
          processMettlePascalCaseReturnWrap(innerPath);
          innerPath.skip();
        }
      },

      ArrowFunctionExpression(innerPath) {
        if (innerPath.node !== path.node) {
          processMettlePascalCaseReturnWrap(innerPath);
          innerPath.skip();
        }
      },
    });
  }

  return {
    name: 'babel-plugin-mettle',
    visitor: {
      Program: {
        exit(programPath, state) {
          const moduleId =
            (typeof state.file.opts.filename === 'string' && state.file.opts.filename) ||
            (typeof state.filename === 'string' && state.filename) ||
            '';

          if (isNodeModulesPath(moduleId)) return;
          if (!options.include.test(moduleId)) return;

          const ast = state.file.ast;

          traverse(ast, {
            FunctionDeclaration(path) {
              processMettlePascalCaseReturnWrap(path);
            },
            FunctionExpression(path) {
              processMettlePascalCaseReturnWrap(path);
            },
            ArrowFunctionExpression(path) {
              processMettlePascalCaseReturnWrap(path);
            },
          });

          let hasSignalImport = false;
          let hasComputedImport = false;
          let importDeclarations = [];
          let mettleSignalLocal = null;
          let mettleComputedLocal = null;
          let mettleEffectLocal = null;

          try {
            const componentPaths = [];
            const seenTransformFn = new Set();
            const pushTransformTarget = (path) => {
              const n = path.node;
              if (seenTransformFn.has(n)) return;
              seenTransformFn.add(n);
              componentPaths.push(path);
            };

            traverse(ast, {
              ImportDeclaration(path) {
                importDeclarations.push(path);
                if (path.node.source.value !== 'mettle') return;
                for (const spec of path.node.specifiers) {
                  if (!t.isImportSpecifier(spec)) continue;
                  const imp = spec.imported?.name;
                  const loc = spec.local.name;
                  if (imp === 'signal') {
                    hasSignalImport = true;
                    mettleSignalLocal = loc;
                  }
                  if (imp === 'computed') {
                    hasComputedImport = true;
                    mettleComputedLocal = loc;
                  }
                  if (imp === 'effect') {
                    mettleEffectLocal = loc;
                  }
                }
              },
              FunctionDeclaration(path) {
                if (!t.isBlockStatement(path.node.body)) return;
                const stmts = path.node.body.body;
                if (isMettleComponentBody(t, stmts) || fnPathHasSignalSugar(t, path)) {
                  pushTransformTarget(path);
                }
              },
              VariableDeclarator(path) {
                const init = path.node.init;
                if (!init) return;
                if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
                  const initPath = path.get('init');
                  if (isMettleFunctionBody(t, init) || fnPathHasSignalSugar(t, initPath)) {
                    pushTransformTarget(initPath);
                  }
                }
              },
              ExportDefaultDeclaration(path) {
                const decl = path.node.declaration;
                if (t.isFunctionDeclaration(decl)) {
                  const declPath = path.get('declaration');
                  if (!t.isBlockStatement(decl.body)) return;
                  if (
                    isMettleComponentBody(t, decl.body.body) ||
                    fnPathHasSignalSugar(t, declPath)
                  ) {
                    pushTransformTarget(declPath);
                  }
                } else if (t.isArrowFunctionExpression(decl)) {
                  const declPath = path.get('declaration');
                  if (isMettleFunctionBody(t, decl) || fnPathHasSignalSugar(t, declPath)) {
                    pushTransformTarget(declPath);
                  }
                }
              },
              ExportNamedDeclaration(path) {
                const decl = path.node.declaration;
                if (!decl) return;
                if (t.isFunctionDeclaration(decl)) {
                  const declPath = path.get('declaration');
                  if (!t.isBlockStatement(decl.body)) return;
                  if (
                    isMettleComponentBody(t, decl.body.body) ||
                    fnPathHasSignalSugar(t, declPath)
                  ) {
                    pushTransformTarget(declPath);
                  }
                } else if (t.isVariableDeclaration(decl)) {
                  for (const declaratorPath of path.get('declaration').get('declarations')) {
                    const init = declaratorPath.node.init;
                    if (!init) continue;
                    if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
                      const initPath = declaratorPath.get('init');
                      if (isMettleFunctionBody(t, init) || fnPathHasSignalSugar(t, initPath)) {
                        pushTransformTarget(initPath);
                      }
                    }
                  }
                }
              },
            });

            if (componentPaths.length === 0) return;

            componentPaths.sort((a, b) => {
              const ah = pathIsStateOnlyHook(t, a);
              const bh = pathIsStateOnlyHook(t, b);
              if (ah === bh) return 0;
              return ah ? -1 : 1;
            });

            const hookReactiveReturnKeys = new Map();
            const signalMultiArgByDecl = new WeakMap();

            let anyComponentTransformed = false;

            const signalId = () => t.identifier(mettleSignalLocal ?? 'signal');
            const computedId = () => t.identifier(mettleComputedLocal ?? 'computed');
            const computedCalleeName = () => mettleComputedLocal ?? 'computed';
            const effectCalleeName = () => mettleEffectLocal ?? 'effect';

            /** Scan declarations once per target function — avoids full-file traverse per component (O(components × file size)). */
            const componentFnNodeSet = new Set(componentPaths.map((p) => p.node));
            const signalDeclPathsByFn = new Map();
            const computedBindingNamesByFn = new Map();
            traverse(ast, {
              VariableDeclarator(declPath) {
                const fp = declPath.getFunctionParent();
                if (!fp || !componentFnNodeSet.has(fp.node)) return;
                const fnNode = fp.node;
                if (!t.isIdentifier(declPath.node.id)) return;
                const init = declPath.node.init;
                if (
                  t.isCallExpression(init) &&
                  t.isIdentifier(init.callee) &&
                  init.callee.name === '$signal'
                ) {
                  let list = signalDeclPathsByFn.get(fnNode);
                  if (!list) {
                    list = [];
                    signalDeclPathsByFn.set(fnNode, list);
                  }
                  list.push(declPath);
                }
                const declKind = declPath.parentPath.node.kind;
                // preset-env may lower const to var; only accepting const would drop computed bindings and skip .value in templates
                if (declKind !== 'const' && declKind !== 'let' && declKind !== 'var') return;
                const nm = declPath.node.id.name;
                if (options.excludeVars.includes(nm)) return;
                const calleeName = init?.callee?.name;
                if (calleeName === computedCalleeName()) {
                  let names = computedBindingNamesByFn.get(fnNode);
                  if (!names) {
                    names = new Set();
                    computedBindingNamesByFn.set(fnNode, names);
                  }
                  names.add(nm);
                }
              },
            });

            for (const componentFnPath of componentPaths) {
              const reactiveVars = new Set();

              const isStateOnlyHook = pathIsStateOnlyHook(t, componentFnPath);

              const candidates = new Set();
              for (const path of signalDeclPathsByFn.get(componentFnPath.node) ?? []) {
                if (!t.isIdentifier(path.node.id)) continue;
                const varName = path.node.id.name;
                const args = path.node.init.arguments;
                if (args.length > 1) signalMultiArgByDecl.set(path.node, args);
                path.node.init =
                  args.length === 0
                    ? t.identifier('undefined')
                    : args.length === 1
                      ? args[0]
                      : args[0];

                candidates.add(varName);
              }

              const computedBindingCandidates =
                computedBindingNamesByFn.get(componentFnPath.node) ?? new Set();

              const computedRefVars = new Set();

              for (const n of candidates) reactiveVars.add(n);

              if (!options.restrictToTemplateReach || isStateOnlyHook) {
                for (const n of computedBindingCandidates) computedRefVars.add(n);
              } else {
                const collectExprIds = (expPath, into) => {
                  if (!expPath?.node) return;
                  if (expPath.isIdentifier()) {
                    into.add(expPath.node.name);
                    return;
                  }
                  expPath.traverse({
                    Identifier(p) {
                      if (p.isReferencedIdentifier()) into.add(p.node.name);
                    },
                  });
                };

                /** PascalCase may wrap `return <jsx/>` as `return function(){ return <jsx/> }` — unwrap to the inner view root */
                const unwrapViewRoot = (path0) => {
                  let p = path0;
                  while (p?.node) {
                    while (p.isParenthesizedExpression()) p = p.get('expression');
                    if (p.isFunctionExpression() || p.isArrowFunctionExpression()) {
                      const body = p.get('body');
                      if (body.isBlockStatement() && body.node.body.length === 1) {
                        const first = body.get('body.0');
                        if (first.isReturnStatement() && first.node.argument) {
                          p = first.get('argument');
                          continue;
                        }
                      } else if (p.isArrowFunctionExpression() && body.isExpression()) {
                        p = body;
                        continue;
                      }
                    }
                    break;
                  }
                  return p;
                };

                const isJsxRuntimeCallee = (callee) =>
                  t.isIdentifier(callee) &&
                  (callee.name === '_jsx' ||
                    callee.name === '_jsxs' ||
                    callee.name === 'jsx' ||
                    callee.name === 'jsxs');

                /** When preset-react lowered JSX to _jsx/_jsxs, collect identifiers from props.children (else computed refs miss computedRefVars) */
                const collectViewSeedsDeep = (expPath, into) => {
                  if (!expPath?.node) return;
                  expPath.traverse({
                    JSXExpressionContainer(p) {
                      const ex = p.get('expression');
                      if (!ex.isJSXEmptyExpression()) collectExprIds(ex, into);
                    },
                    JSXSpreadAttribute(p) {
                      collectExprIds(p.get('argument'), into);
                    },
                    JSXAttribute(p) {
                      const v = p.node.value;
                      if (t.isJSXExpressionContainer(v)) {
                        const ex = p.get('value').get('expression');
                        if (!ex.isJSXEmptyExpression()) collectExprIds(ex, into);
                      }
                    },
                    CallExpression(p) {
                      if (!isJsxRuntimeCallee(p.node.callee)) return;
                      const args = p.node.arguments;
                      if (args.length < 2) return;
                      const propsPath = p.get('arguments.1');
                      if (!propsPath?.node || !t.isObjectExpression(propsPath.node)) return;
                      for (const propPath of propsPath.get('properties')) {
                        const prop = propPath.node;
                        if (!t.isObjectProperty(prop) || prop.computed) continue;
                        const k = prop.key;
                        const keyName = t.isIdentifier(k)
                          ? k.name
                          : t.isStringLiteral(k)
                            ? k.value
                            : null;
                        if (keyName !== 'children') continue;
                        const valPath = propPath.get('value');
                        if (valPath.isArrayExpression()) {
                          for (const elPath of valPath.get('elements')) {
                            if (elPath.node) collectExprIds(elPath, into);
                          }
                        } else {
                          collectExprIds(valPath, into);
                        }
                      }
                    },
                  });
                };

                const funcMap = new Map();
                componentFnPath.traverse({
                  FunctionDeclaration(p) {
                    if (p.getFunctionParent()?.node !== componentFnPath.node) return;
                    if (p.node.id) funcMap.set(p.node.id.name, p);
                  },
                  VariableDeclarator(p) {
                    if (!declaratorInFunctionScope(p, componentFnPath)) return;
                    const init = p.get('init');
                    if (
                      init &&
                      (init.isFunctionExpression() || init.isArrowFunctionExpression()) &&
                      t.isIdentifier(p.node.id)
                    ) {
                      funcMap.set(p.node.id.name, init);
                    }
                  },
                });

                const jsxSeeds = new Set();
                const bodyPath = componentFnPath.get('body');
                bodyPath.traverse({
                  ReturnStatement(retPath) {
                    if (retPath.getFunctionParent()?.node !== componentFnPath.node) return;
                    const argPath0 = retPath.get('argument');
                    if (!argPath0?.node) return;
                    const viewRoot = unwrapViewRoot(argPath0);
                    collectViewSeedsDeep(viewRoot, jsxSeeds);
                  },
                });

                const fnQueued = new Set();
                const fnQueue = [];
                const noteSeed = (name) => {
                  if (!name) return;
                  if (computedBindingCandidates.has(name)) computedRefVars.add(name);
                  if (funcMap.has(name) && !fnQueued.has(name)) {
                    fnQueued.add(name);
                    fnQueue.push(name);
                  }
                };
                for (const name of jsxSeeds) noteSeed(name);

                while (fnQueue.length) {
                  const fnName = fnQueue.shift();
                  const fnPath = funcMap.get(fnName);
                  if (!fnPath) continue;
                  fnPath.traverse({
                    Identifier(p) {
                      if (!p.isReferencedIdentifier()) return;
                      const n = p.node.name;
                      if (computedBindingCandidates.has(n)) computedRefVars.add(n);
                      if (funcMap.has(n) && !fnQueued.has(n)) {
                        fnQueued.add(n);
                        fnQueue.push(n);
                      }
                    },
                  });
                }
              }

              if (isStateOnlyHook && reactiveVars.size > 0) {
                hookReactiveReturnKeys.set(
                  componentFnPath.node,
                  extractHookExportedReactiveKeys(t, componentFnPath.node, reactiveVars, ast),
                );
              }

              const destructuredReactiveVars = new Set();
              const destructuredUnwrapBindings = new Map();
              const bodyStmtPath = componentFnPath.get('body');
              if (bodyStmtPath.isBlockStatement()) {
                for (const stmtPath of bodyStmtPath.get('body')) {
                  if (!stmtPath.isVariableDeclaration()) continue;
                  for (const declPath of stmtPath.get('declarations')) {
                    const destructurePat = declPath.node.id;
                    if (!t.isObjectPattern(destructurePat)) continue;
                    const init = declPath.node.init;
                    if (!t.isCallExpression(init) || !t.isIdentifier(init.callee)) continue;
                    const binding = componentFnPath.scope.getBinding(init.callee.name);
                    if (!binding) continue;
                    let hookFnNode = null;
                    if (binding.path.isFunctionDeclaration()) {
                      hookFnNode = binding.path.node;
                    } else if (binding.path.isVariableDeclarator()) {
                      const ini = binding.path.node.init;
                      if (t.isArrowFunctionExpression(ini) || t.isFunctionExpression(ini)) {
                        hookFnNode = ini;
                      }
                    }
                    let exported = null;
                    if (hookFnNode) {
                      exported = hookReactiveReturnKeys.get(hookFnNode);
                      if (!exported || exported.size === 0) {
                        const calleeNm = init.callee.name;
                        for (const [fnNode, keys] of hookReactiveReturnKeys) {
                          if (!keys?.size) continue;
                          if (t.isFunctionDeclaration(fnNode) && fnNode.id?.name === calleeNm) {
                            exported = keys;
                            break;
                          }
                        }
                      }
                    }
                    if (!exported || exported.size === 0) continue;
                    for (const prop of destructurePat.properties) {
                      if (t.isRestElement(prop)) break;
                      if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.key)) {
                        continue;
                      }
                      const exportKey = prop.key.name;
                      if (!exported.has(exportKey)) continue;
                      if (prop.shorthand) {
                        destructuredReactiveVars.add(exportKey);
                        destructuredUnwrapBindings.set(
                          exportKey,
                          declPath.scope.getBinding(exportKey),
                        );
                      } else if (t.isIdentifier(prop.value)) {
                        const localNm = prop.value.name;
                        destructuredReactiveVars.add(localNm);
                        destructuredUnwrapBindings.set(localNm, declPath.scope.getBinding(localNm));
                      }
                    }
                  }
                }
              }

              if (
                reactiveVars.size === 0 &&
                computedRefVars.size === 0 &&
                destructuredReactiveVars.size === 0
              ) {
                continue;
              }

              anyComponentTransformed = true;

              /** When auto-appending `.value`, match Binding so inner shadowed identifiers with the same name are not rewritten */
              const valueUnwrapBinding = new Map();
              for (const declPath of signalDeclPathsByFn.get(componentFnPath.node) ?? []) {
                if (!t.isIdentifier(declPath.node.id)) continue;
                const nm = declPath.node.id.name;
                const b = declPath.scope.getBinding(nm);
                if (b) valueUnwrapBinding.set(nm, b);
              }
              componentFnPath.traverse({
                VariableDeclarator(path) {
                  if (!declaratorInFunctionScope(path, componentFnPath)) return;
                  if (!t.isIdentifier(path.node.id)) return;
                  const nm = path.node.id.name;
                  if (!computedRefVars.has(nm)) return;
                  const init = path.node.init;
                  if (!t.isCallExpression(init) || !t.isIdentifier(init.callee)) return;
                  if (init.callee.name !== computedCalleeName()) return;
                  const b = path.scope.getBinding(nm);
                  if (b) valueUnwrapBinding.set(nm, b);
                },
              });
              for (const [nm, b] of destructuredUnwrapBindings) {
                if (b) valueUnwrapBinding.set(nm, b);
              }

              const needsValueUnwrap = (name) =>
                reactiveVars.has(name) ||
                computedRefVars.has(name) ||
                destructuredReactiveVars.has(name);

              const bindingMatchesValueUnwrap = (name, idPath) => {
                const expected = valueUnwrapBinding.get(name);
                if (!expected) return false;
                return idPath.scope.getBinding(name) === expected;
              };

              const autoAppendValue = (path) => {
                const node = path.node;
                if (!t.isIdentifier(node) || !needsValueUnwrap(node.name)) return;
                if (!path.isReferencedIdentifier()) return;
                if (!bindingMatchesValueUnwrap(node.name, path)) return;
                if (t.isCallExpression(path.parent) && path.parent.callee === node) return;
                if (t.isAssignmentExpression(path.parent) && path.parent.left === node) return;
                if (t.isUpdateExpression(path.parent) && path.parent.argument === node) return;
                if (
                  t.isMemberExpression(path.parent) &&
                  path.parent.object === node &&
                  t.isIdentifier(path.parent.property) &&
                  path.parent.property.name === 'value'
                ) {
                  return;
                }

                path.replaceWith(t.memberExpression(node, t.identifier('value')));
              };

              const traverseLoopAndSwitchHeads = {
                ForStatement(path) {
                  const i = path.get('init');
                  const te = path.get('test');
                  const u = path.get('update');
                  if (i.node) i.traverse({ Identifier: autoAppendValue });
                  if (te.node) te.traverse({ Identifier: autoAppendValue });
                  if (u.node) u.traverse({ Identifier: autoAppendValue });
                },
                ForOfStatement(path) {
                  path.get('right').traverse({ Identifier: autoAppendValue });
                },
                ForInStatement(path) {
                  path.get('right').traverse({ Identifier: autoAppendValue });
                },
                WhileStatement(path) {
                  path.get('test').traverse({ Identifier: autoAppendValue });
                },
                DoWhileStatement(path) {
                  path.get('test').traverse({ Identifier: autoAppendValue });
                },
                SwitchStatement(path) {
                  path.get('discriminant').traverse({ Identifier: autoAppendValue });
                },
              };

              componentFnPath.traverse({
                ...traverseLoopAndSwitchHeads,
                ReturnStatement(path) {
                  if (path.getFunctionParent()?.node !== componentFnPath.node) return;
                  const arg = path.get('argument');
                  if (!arg.node) return;
                  if (arg.isIdentifier()) {
                    autoAppendValue(arg);
                  } else {
                    arg.traverse({ Identifier: autoAppendValue });
                  }
                },
                ExpressionStatement(path) {
                  if (path.getFunctionParent()?.node !== componentFnPath.node) return;
                  const exp = path.get('expression');
                  if (!exp.node) return;
                  if (exp.isIdentifier()) {
                    autoAppendValue(exp);
                  } else {
                    exp.traverse({ Identifier: autoAppendValue });
                  }
                },
                JSXExpressionContainer(path) {
                  const expPath = path.get('expression');
                  if (expPath.isIdentifier()) {
                    autoAppendValue(expPath);
                  } else {
                    expPath.traverse({ Identifier: autoAppendValue });
                  }
                },
                CallExpression(path) {
                  let calleeName = null;
                  if (t.isIdentifier(path.node.callee)) calleeName = path.node.callee.name;
                  const isComputedOrEffect =
                    calleeName != null &&
                    (calleeName === computedCalleeName() || calleeName === effectCalleeName());
                  if (isComputedOrEffect) {
                    const fnPath = path.get('arguments.0');
                    if (fnPath?.isFunction()) {
                      const bodyPath = fnPath.get('body');
                      if (bodyPath.isBlockStatement()) {
                        bodyPath.traverse({ Identifier: autoAppendValue });
                      } else if (bodyPath.isIdentifier()) {
                        autoAppendValue(bodyPath);
                      } else {
                        bodyPath.traverse({ Identifier: autoAppendValue });
                      }
                    }
                    for (let i = 1; i < path.node.arguments.length; i++) {
                      const ap = path.get(`arguments.${i}`);
                      if (ap.node) ap.traverse({ Identifier: autoAppendValue });
                    }
                  } else {
                    for (let i = 0; i < path.node.arguments.length; i++) {
                      const ap = path.get(`arguments.${i}`);
                      if (ap.node) ap.traverse({ Identifier: autoAppendValue });
                    }
                  }
                },
                BinaryExpression: {
                  enter(path) {
                    path.traverse({ Identifier: autoAppendValue });
                  },
                },
                LogicalExpression: {
                  enter(path) {
                    path.traverse({ Identifier: autoAppendValue });
                  },
                },
                ConditionalExpression: {
                  enter(path) {
                    path.traverse({ Identifier: autoAppendValue });
                  },
                },
                UnaryExpression: {
                  enter(path) {
                    path.traverse({ Identifier: autoAppendValue });
                  },
                },
                MemberExpression(path) {
                  const { object, property } = path.node;
                  const objPath = path.get('object');
                  if (
                    t.isIdentifier(object) &&
                    t.isIdentifier(property) &&
                    property.name === 'value' &&
                    needsValueUnwrap(object.name) &&
                    bindingMatchesValueUnwrap(object.name, objPath)
                  ) {
                    return;
                  }
                  if (
                    t.isIdentifier(object) &&
                    needsValueUnwrap(object.name) &&
                    bindingMatchesValueUnwrap(object.name, objPath)
                  ) {
                    path.node.object = t.memberExpression(object, t.identifier('value'));
                  }
                },
                AssignmentExpression(path) {
                  path.get('right').traverse({ Identifier: autoAppendValue });
                },
                VariableDeclarator(path) {
                  if (!declaratorInFunctionScope(path, componentFnPath)) return;
                  const init = path.get('init');
                  if (init.node) init.traverse({ Identifier: autoAppendValue });
                },
              });

              componentFnPath.traverse({
                ...traverseLoopAndSwitchHeads,
                AssignmentExpression(path) {
                  const leftPath = path.get('left');
                  if (leftPath.isIdentifier() && reactiveVars.has(leftPath.node.name)) {
                    if (bindingMatchesValueUnwrap(leftPath.node.name, leftPath)) {
                      path.node.left = t.memberExpression(leftPath.node, t.identifier('value'));
                    }
                  } else if (leftPath.isMemberExpression()) {
                    const left = leftPath.node;
                    if (t.isIdentifier(left.object) && reactiveVars.has(left.object.name)) {
                      const objPath = leftPath.get('object');
                      if (bindingMatchesValueUnwrap(left.object.name, objPath)) {
                        path.node.left.object = t.memberExpression(
                          left.object,
                          t.identifier('value'),
                        );
                      }
                    }
                  }
                },
                UpdateExpression(path) {
                  const argPath = path.get('argument');
                  if (argPath.isIdentifier() && reactiveVars.has(argPath.node.name)) {
                    if (bindingMatchesValueUnwrap(argPath.node.name, argPath)) {
                      path.node.argument = t.memberExpression(argPath.node, t.identifier('value'));
                    }
                  }
                },
              });

              componentFnPath.traverse({
                VariableDeclarator(path) {
                  if (!declaratorInFunctionScope(path, componentFnPath)) return;
                  if (!t.isIdentifier(path.node.id)) return;
                  const varName = path.node.id.name;
                  if (!reactiveVars.has(varName)) return;

                  const init = path.node.init || t.identifier('undefined');
                  const multiArgs = signalMultiArgByDecl.get(path.node);

                  let hasReactiveDep = false;
                  if (path.node.init) {
                    const initPath = path.get('init');
                    if (initPath.isIdentifier()) {
                      const nm = initPath.node.name;
                      const exp = valueUnwrapBinding.get(nm);
                      if (reactiveVars.has(nm) && exp && initPath.scope.getBinding(nm) === exp) {
                        hasReactiveDep = true;
                      }
                    } else {
                      initPath.traverse({
                        Identifier(p) {
                          if (!p.isReferencedIdentifier()) return;
                          const nm = p.node.name;
                          const exp = valueUnwrapBinding.get(nm);
                          if (reactiveVars.has(nm) && exp && p.scope.getBinding(nm) === exp) {
                            hasReactiveDep = true;
                          }
                        },
                      });
                    }
                  }

                  if (multiArgs && multiArgs.length > 1) {
                    path.node.init = t.callExpression(signalId(), multiArgs);
                    if (mettleSignalLocal == null) hasSignalImport = false;
                  } else if (hasReactiveDep) {
                    path.node.init = t.callExpression(computedId(), [
                      t.arrowFunctionExpression([], init),
                    ]);
                    if (mettleComputedLocal == null) hasComputedImport = false;
                  } else {
                    path.node.init = t.callExpression(signalId(), [init]);
                    if (mettleSignalLocal == null) hasSignalImport = false;
                  }
                },
              });
            }

            if (!anyComponentTransformed) return;

            const importSpecifiers = [];
            if (!hasSignalImport)
              importSpecifiers.push(
                t.importSpecifier(t.identifier('signal'), t.identifier('signal')),
              );
            if (!hasComputedImport)
              importSpecifiers.push(
                t.importSpecifier(t.identifier('computed'), t.identifier('computed')),
              );

            if (importSpecifiers.length > 0) {
              const mettleImport = importDeclarations.find((p) => p.node.source.value === 'mettle');
              if (mettleImport) {
                appendMettleSpecifiers(t, mettleImport, importSpecifiers);
              } else {
                ast.program.body.unshift(
                  t.importDeclaration(importSpecifiers, t.stringLiteral('mettle')),
                );
              }
            }
          } catch (err) {
            console.error(`[babel-plugin-mettle] Transform failed: ${moduleId}`, err);
          }
        },
      },
    },
  };
}

module.exports = babelPluginMettle;
