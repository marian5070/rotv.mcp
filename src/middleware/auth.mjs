export function authOptional(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return next();
  if (req.path === '/mcp/health') return next();
  const header = req.headers['authorization'] || '';
  if (header === `Bearer ${token}`) return next();
  res.status(401).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Unauthorized' },
  });
}
