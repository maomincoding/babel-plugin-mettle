module.exports = function ({ types: t }) {
  function isFirstCharUpperCase(str) {
    return /^[A-Z]/.test(str);
  }

  function isSignalBinding(binding) {
    if (!binding) return false;
    const { init } = binding.path.node;
    return (
      t.isCallExpression(init) &&
      t.isIdentifier(init.callee) &&
      (init.callee.name === 'signal' || init.callee.name === 'computed')
    );
  }

  function isInsideCustomComponentAttribute(path) {
    const parent = path.parentPath;
    if (t.isJSXAttribute(parent.node)) {
      const element = parent.parentPath?.parentPath?.node.openingElement;
      if (t.isJSXOpeningElement(element) && t.isJSXIdentifier(element.name)) {
        const tagName = element.name.name;
        return isFirstCharUpperCase(tagName);
      }
    }
    return false;
  }

  return {
    name: 'babel-plugin-mettle',
    visitor: {
      FunctionDeclaration(path) {
        if (path.node.id && isFirstCharUpperCase(path.node.id.name)) {
          const returnStatement = path.node.body.body.find((node) => t.isReturnStatement(node));

          if (returnStatement && returnStatement.argument) {
            const newFunction = t.functionExpression(
              null,
              [],
              t.blockStatement([t.returnStatement(returnStatement.argument)])
            );

            returnStatement.argument = newFunction;
          }
        }
      },
      JSXExpressionContainer(path) {
        const { expression } = path.node;

        if (t.isIdentifier(expression)) {
          const name = expression.name;
          const binding = path.scope.getBinding(name);
          if ((binding && isSignalBinding(binding)) || name.endsWith('$')) {
            if (!isInsideCustomComponentAttribute(path)) {
              path.node.expression = t.memberExpression(t.identifier(name), t.identifier('value'));
            }
          }
        }

        // Member Expression
        if (t.isCallExpression(expression)) {
          if (t.isMemberExpression(expression.callee) && t.isIdentifier(expression.callee.object)) {
            const name = expression.callee.object.name;
            const binding = path.scope.getBinding(name);
            if ((binding && isSignalBinding(binding)) || name.endsWith('$')) {
              expression.callee.object = t.memberExpression(
                expression.callee.object,
                t.identifier('value')
              );
            }
          }
        }

        // Conditional Expressions
        if (t.isConditionalExpression(expression)) {
          if (t.isIdentifier(expression.test)) {
            const name = expression.test.name;
            const binding = path.scope.getBinding(name);
            if ((binding && isSignalBinding(binding)) || name.endsWith('$')) {
              expression.test = t.memberExpression(expression.test, t.identifier('value'));
            }
          }
        }
      },
    },
  };
};
