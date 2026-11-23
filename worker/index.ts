interface Env {
  ASSETS: Fetcher
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

interface ScheduledController {
  cron: string
  scheduledTime: number
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request)
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/finalize_due_signup`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    if (!response.ok) {
      const details = await response.text()
      throw new Error(`Weekly selection failed (${response.status}): ${details}`)
    }
  },
} satisfies ExportedHandler<Env>
