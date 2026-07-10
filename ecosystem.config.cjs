module.exports = {
  apps: [{
    name: 'rotv-mcp',
    script: './src/server.mjs',
    cwd: '/opt/apps/rotv-mcp',
    interpreter: 'node',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    kill_timeout: 5000,
    env: {
      NODE_ENV: 'production',
      PORT: '3010',
      RATE_LIMIT_RPM: '60'
    },
    out_file: '/home/marian/.pm2/logs/rotv-mcp-out.log',
    error_file: '/home/marian/.pm2/logs/rotv-mcp-error.log',
    merge_logs: true,
    time: true
  }]
};
