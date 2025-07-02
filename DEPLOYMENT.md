# Deployment

Currently using [fly.io](https://fly.io) for deployment.

The app is deployed as a globally distributed edge instance, minimizing latency for visitors worldwide.  
Fly automatically routes requests to the nearest edge VM using Anycast.

### How to deploy

```bash
fly deploy
```
