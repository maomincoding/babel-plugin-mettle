module.exports = function ({ types: t }) {
  function isFirstCharUpperCase(str) {
    return /^[A-Z]/.test(str);
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
    },
  };
};
