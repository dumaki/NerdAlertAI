// ============================================================
// scripts/calendar-auth.ts  — Phase 4: Calendar OAuth Setup
// ============================================================
// Run this ONCE to get your Google Calendar OAuth tokens.
// Starts a local server on port 8765 to capture the redirect,
// exchanges the code for tokens, and prints the credential JSON.
//
// Prerequisites:
//   1. Go to https://console.cloud.google.com/
//   2. Create a project (or use an existing one)
//   3. Enable the Google Calendar API
//   4. Create OAuth 2.0 credentials — type: Desktop app
//   5. Add http://localhost:8765 as an authorized redirect URI
//   6. Note your Client ID and Client Secret
//
// Usage:
//   npx ts-node scripts/calendar-auth.ts --clientId <id> --clientSecret <secret>
//
// After running, copy the printed JSON to:
//   ~/.nerdalert/secrets/google-calendar.json
// Set file permissions: chmod 600 ~/.nerdalert/secrets/google-calendar.json
// ============================================================

import http  from 'http'
import https from 'https'

const REDIRECT_PORT = 8765
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}`
const SCOPE         = 'https://www.googleapis.com/auth/calendar.readonly'

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args    = argv.slice(2)
  const options: Record<string, string | boolean> = {}
  while (args.length) {
    const token = args.shift()!
    if (!token.startsWith('--')) continue
    const key  = token.slice(2)
    const next = args[0]
    options[key] = (!next || next.startsWith('--')) ? true : args.shift()!
  }
  return options
}

function httpsPost(hostname: string, urlPath: string, body: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = new URLSearchParams(body).toString()
    const req = https.request({
      hostname,
      path:   urlPath,
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e: any) { reject(new Error(`Response parse error: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url   = new URL(req.url!, REDIRECT_URI)
      const code  = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end(`Authorization denied: ${error}\n`)
        server.close()
        reject(new Error(`Authorization denied: ${error}`))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('Authorization successful. You can close this tab.\n')
        server.close()
        resolve(code)
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('No code received.\n')
    })

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${REDIRECT_PORT} is already in use. Stop whatever is using it and try again.`))
      } else {
        reject(err)
      }
    })

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      process.stdout.write(`Waiting for OAuth redirect on ${REDIRECT_URI} ...\n`)
    })
  })
}

async function main() {
  const args         = parseArgs(process.argv)
  const clientId     = args.clientId     as string
  const clientSecret = args.clientSecret as string

  if (!clientId || !clientSecret) {
    process.stderr.write('Usage: npx ts-node scripts/calendar-auth.ts --clientId <id> --clientSecret <secret>\n')
    process.exit(1)
  }

  const authUrl =
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&access_type=offline` +
    `&prompt=consent`

  process.stdout.write('\nOpen this URL in your browser:\n\n')
  process.stdout.write(authUrl + '\n\n')

  let code: string
  try {
    code = await waitForAuthCode()
  } catch (err: any) {
    process.stderr.write(`Failed to receive auth code: ${err.message}\n`)
    process.exit(1)
  }

  process.stdout.write('Code received. Exchanging for tokens...\n')

  let result: any
  try {
    result = await httpsPost('oauth2.googleapis.com', '/token', {
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    })
  } catch (err: any) {
    process.stderr.write(`Token exchange failed: ${err.message}\n`)
    process.exit(1)
  }

  if (!result.refresh_token) {
    process.stderr.write(`No refresh token in response: ${JSON.stringify(result)}\n`)
    process.stderr.write('Make sure you used prompt=consent and access_type=offline.\n')
    process.exit(1)
  }

  const credentialJson = JSON.stringify({
    clientId,
    clientSecret,
    refreshToken:  result.refresh_token,
    calendarId:    'primary',
    lookAheadDays: 7,
  }, null, 2)

  process.stdout.write('\nSuccess. Copy this to ~/.nerdalert/secrets/google-calendar.json\n')
  process.stdout.write('Then run: chmod 600 ~/.nerdalert/secrets/google-calendar.json\n\n')
  process.stdout.write(credentialJson + '\n')
}

main().catch(err => {
  process.stderr.write(`Unexpected error: ${err.message}\n`)
  process.exit(1)
})
