module.exports = {
  apps: [{
    name: "masoi-online",
    script: "./server.js",
    env: {
      NODE_ENV: "production",
      PORT: 3000
    },
    instances: 1,
    exec_mode: "fork"
  }]
}
