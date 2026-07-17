{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash(node:*)",
      "Bash(npm run:*)",
      "Bash(npm install:*)",
      "Bash(npx:*)",
      "Bash(dir:*)",
      "Bash(ls:*)",
      "Bash(mkdir:*)",
      "Bash(copy:*)",
      "Bash(cp:*)",
      "Bash(type:*)",
      "Bash(cat:*)",
      "Bash(curl:*)",
      "WebFetch(domain:{{REACT_HOST}})",
      "WebFetch(domain:{{SHOP_HOST}})",
      "WebFetch(domain:cdn.shopify.com)",
      "Agent",
      "TodoWrite"
    ],
    "deny": [
      "Bash(git push:*)",
      "Bash(rd:*)",
      "Bash(rmdir:*)",
      "Bash(del:*)",
      "Bash(rm -rf:*)"
    ]
  }
}
