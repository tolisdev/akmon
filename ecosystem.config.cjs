module.exports = {
  apps: [
    {
      name: 'ak-mon',
      script: 'server/index.js',
      node_args: '--max-old-space-size=150',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
