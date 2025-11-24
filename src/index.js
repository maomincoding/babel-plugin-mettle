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
      // Static Node
      JSXElement(path) {
        let hasDynamicContent = false;
        const openingElement = path.get('openingElement');

        const hasDynamicChild = path.get('children').some((childPath) => {
          return childPath.isJSXExpressionContainer();
        });

        const hasDynamicAttr = openingElement.get('attributes').some((attrPath) => {
          if (attrPath.isJSXAttribute()) {
            const value = attrPath.get('value');
            if (!value.node) return false;

            if (value.isTemplateLiteral()) {
              return value.node.expressions.length > 0;
            }

            if (value.isJSXExpressionContainer()) {
              const expression = value.get('expression');
              if (
                expression.isStringLiteral() ||
                expression.isNumericLiteral() ||
                expression.isBooleanLiteral()
              ) {
                return false;
              }
              return true;
            }
          }
          return false;
        });

        hasDynamicContent = hasDynamicChild || hasDynamicAttr;

        if (!hasDynamicContent) {
          const hasExistingAttr = openingElement
            .get('attributes')
            .some(
              (attrPath) =>
                attrPath.isJSXAttribute() &&
                attrPath.get('name').isJSXIdentifier({ name: '_staticFlag' })
            );

          if (!hasExistingAttr) {
            const dynamicAttr = t.jSXAttribute(t.jSXIdentifier('_staticFlag'), null);
            openingElement.node.attributes.push(dynamicAttr);
          }
        }
      },
    },
  };
};
