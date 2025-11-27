module.exports = function ({ types: t }) {
  function isFirstCharUpperCase(str) {
    return str && /^[A-Z]/.test(str);
  }

  function getFunctionName(path) {
    if (path.node.id) {
      return path.node.id.name;
    }

    if (t.isVariableDeclarator(path.parent)) {
      return path.parent.id.name;
    }

    if (t.isAssignmentExpression(path.parent)) {
      return path.parent.left.property?.name;
    }

    if (t.isProperty(path.parent)) {
      return path.parent.key.name;
    }

    return null;
  }

  function processFunction(path) {
    const functionName = getFunctionName(path);

    if (!isFirstCharUpperCase(functionName)) {
      return;
    }

    if (path.isArrowFunctionExpression() && !t.isBlockStatement(path.node.body)) {
      const returnExpr = path.node.body;
      const blockBody = t.blockStatement([t.returnStatement(returnExpr)]);
      path.node.body = blockBody;
    }

    path.traverse({
      ReturnStatement(returnPath) {
        if (returnPath.getFunctionParent() === path && returnPath.node.argument) {
          const newFunction = t.functionExpression(
            null,
            [],
            t.blockStatement([t.returnStatement(returnPath.node.argument)])
          );
          returnPath.node.argument = newFunction;
        }
      },

      FunctionDeclaration(innerPath) {
        if (innerPath !== path) {
          processFunction(innerPath);
          innerPath.skip();
        }
      },

      FunctionExpression(innerPath) {
        if (innerPath !== path) {
          processFunction(innerPath);
          innerPath.skip();
        }
      },

      ArrowFunctionExpression(innerPath) {
        if (innerPath !== path) {
          processFunction(innerPath);
          innerPath.skip();
        }
      },
    });
  }

  return {
    name: 'babel-plugin-mettle',
    visitor: {
      FunctionDeclaration(path) {
        processFunction(path);
      },
      FunctionExpression(path) {
        processFunction(path);
      },
      ArrowFunctionExpression(path) {
        processFunction(path);
      },
    },
  };
};
