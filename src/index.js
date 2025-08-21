// The first letter of the mettle component name must be capitalized
function isFirstUpperCase(str) {
  return /^[A-Z]/.test(str);
}

module.exports = function ({ types: t }) {
  return {
    name: 'babel-plugin-mettle',
    visitor: {
      FunctionDeclaration(path) {
        if (path.node.id && isFirstUpperCase(path.node.id.name)) {
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
