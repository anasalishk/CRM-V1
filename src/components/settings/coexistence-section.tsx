'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Smartphone,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
  QrCode,
  Info,
  PowerOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types'

declare global {
  interface Window {
    fbAsyncInit?: () => void
    FB?: {
      init: (params: {
        appId: string
        cookie?: boolean
        xfbml?: boolean
        version: string
      }) => void
      login: (
        callback: (response: {
          authResponse?: {
            code?: string
            accessToken?: string
            userID?: string
            expiresIn?: number
            signedRequest?: string
          }
          status?: string
        }) => void,
        options: {
          config_id?: string
          response_type?: string
          override_default_response_type?: boolean
          extras?: Record<string, unknown>
        }
      ) => void
    }
  }
}

interface CoexistenceSectionProps {
  config: WhatsAppConfigType | null
  phoneInfo?: {
    display_phone_number?: string
    verified_name?: string
    quality_rating?: string
  } | null
  canEditSettings: boolean
  onConfigChange: () => Promise<void>
}

interface ClientConfig {
  appId: string
  configId: string
  graphVersion: string
  configured: boolean
}

export function CoexistenceSection({
  config,
  phoneInfo,
  canEditSettings,
  onConfigChange,
}: CoexistenceSectionProps) {
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null)
  const [showQrNotice, setShowQrNotice] = useState(false)

  const isCoexistence = config?.connection_mode === 'coexistence'
  const isConnected = config?.status === 'connected' && isCoexistence

  // Fetch public Meta client configuration
  useEffect(() => {
    fetch('/api/whatsapp/coexistence/client-config')
      .then((res) => res.json())
      .then((data: ClientConfig) => setClientConfig(data))
      .catch((err) => console.error('Failed to load client config:', err))
  }, [])

  function loadFacebookSdk(appId: string, version: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined') return resolve()
      if (window.FB) {
        resolve()
        return
      }

      window.fbAsyncInit = function () {
        window.FB?.init({
          appId,
          cookie: true,
          xfbml: true,
          version,
        })
        resolve()
      }

      if (document.getElementById('facebook-jssdk')) {
        resolve()
        return
      }

      const js = document.createElement('script')
      js.id = 'facebook-jssdk'
      js.src = 'https://connect.facebook.net/en_US/sdk.js'
      document.body.appendChild(js)
    })
  }

  async function handleStartCoexistence() {
    if (!clientConfig?.configured) {
      toast.error(
        'Meta configuration missing: Please set META_APP_ID and META_CONFIG_ID in .env.local before onboarding.',
        { duration: 8000 }
      )
      return
    }

    try {
      setConnecting(true)
      setShowQrNotice(true)

      // Ensure FB JS SDK is loaded
      await loadFacebookSdk(clientConfig.appId, clientConfig.graphVersion)

      let capturedPhoneId: string | null = null
      let capturedWabaId: string | null = null

      const messageListener = (event: MessageEvent) => {
        if (
          event.origin !== 'https://www.facebook.com' &&
          event.origin !== 'https://web.facebook.com'
        ) {
          return
        }

        try {
          const raw = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
          if (raw?.type === 'WA_EMBEDDED_SIGNUP') {
            if (raw.event === 'FINISH' || raw.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
              capturedPhoneId = raw.data?.phone_number_id || null
              capturedWabaId = raw.data?.waba_id || null
              console.log('[coexistence] Embedded signup finished, IDs captured:', {
                phone_number_id: capturedPhoneId,
                waba_id: capturedWabaId,
              })
            } else if (raw.event === 'CANCEL') {
              toast.info('Embedded signup was cancelled.')
            } else if (raw.event === 'ERROR') {
              console.error('[coexistence] Embedded signup error event:', raw.data)
              toast.error(`Onboarding error: ${raw.data?.error_message || 'Verification failed'}`)
            }
          }
        } catch {
          // ignore non-JSON messages
        }
      }

      window.addEventListener('message', messageListener)

      window.FB?.login(
        (response) => {
          void (async () => {
            window.removeEventListener('message', messageListener)
            setShowQrNotice(false)

            if (response.authResponse?.code) {
              const authCode = response.authResponse.code

              if (!capturedPhoneId || !capturedWabaId) {
                toast.error(
                  'Could not capture Phone Number ID or WABA ID from Embedded Signup. Please try again.',
                  { duration: 8000 }
                )
                setConnecting(false)
                return
              }

              toast.loading('Finalizing WhatsApp Coexistence connection...', { id: 'coex-complete' })

              const completeRes = await fetch('/api/whatsapp/coexistence/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  code: authCode,
                  phone_number_id: capturedPhoneId,
                  waba_id: capturedWabaId,
                }),
              })

              const completeData = await completeRes.json()
              toast.dismiss('coex-complete')

              if (!completeRes.ok) {
                toast.error(completeData.error || 'Failed to complete Coexistence onboarding.', {
                  duration: 10000,
                })
                setConnecting(false)
                return
              }

              toast.success(
                'Connected! Your existing WhatsApp Business App number is now linked in Coexistence mode.'
              )
              await onConfigChange()
            } else {
              setConnecting(false)
            }
          })()
        },
        {
          config_id: clientConfig.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: {
            setup: {},
            featureType: 'whatsapp_business_app_onboarding',
            sessionInfoVersion: '3',
          },
        }
      )
    } catch (err) {
      console.error('Coexistence onboarding error:', err)
      toast.error('Failed to launch Embedded Signup flow.')
      setConnecting(false)
      setShowQrNotice(false)
    }
  }

  async function handleDisconnect() {
    if (
      !confirm(
        'Disconnect this WhatsApp Coexistence integration? This safely removes our API subscription and will NOT log out or affect the WhatsApp Business App on your phone.'
      )
    ) {
      return
    }

    try {
      setDisconnecting(true)
      const res = await fetch('/api/whatsapp/coexistence/disconnect', { method: 'POST' })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Failed to disconnect.')
        return
      }

      toast.success('WhatsApp Coexistence disconnected safely.')
      await onConfigChange()
    } catch (err) {
      console.error('Disconnect error:', err)
      toast.error('Failed to disconnect.')
    } finally {
      setDisconnecting(false)
    }
  }

  // If already connected in Coexistence mode:
  if (isConnected) {
    const contactsStatus = config?.contacts_sync_status || 'completed'
    const historyStatus = config?.history_sync_status || 'pending'
    const historyProgress = config?.history_sync_progress ?? 0

    return (
      <Card className="border-emerald-600/40 bg-card">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
                <Smartphone className="size-5" />
              </div>
              <div>
                <CardTitle className="text-base text-foreground flex items-center gap-2">
                  Mode: Coexistence (Business App + API)
                  <Badge variant="outline" className="border-emerald-500/50 bg-emerald-500/10 text-emerald-400 text-xs font-medium">
                    Active
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Your phone app and wacrm Cloud API work on the same number at the same time.
                </CardDescription>
              </div>
            </div>
            {canEditSettings && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="border-red-900/50 bg-red-950/20 text-red-300 hover:bg-red-950/40 hover:text-red-200 text-xs h-8"
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin mr-1.5" />
                    Disconnecting...
                  </>
                ) : (
                  <>
                    <PowerOff className="size-3.5 mr-1.5 text-red-400" />
                    Disconnect Coexistence
                  </>
                )}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-1">
          {/* Metadata Display */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <div>
              <p className="text-muted-foreground font-medium">Phone Number</p>
              <p className="font-semibold text-foreground mt-0.5">
                {phoneInfo?.display_phone_number || config?.phone_number_id}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium">Verified Name</p>
              <p className="font-semibold text-foreground mt-0.5">
                {phoneInfo?.verified_name || 'Standard Account'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium">Quality Rating</p>
              <p className="font-semibold text-foreground mt-0.5">
                {phoneInfo?.quality_rating || 'GREEN'}
              </p>
            </div>
          </div>

          {/* Sync Status Indicators */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-emerald-400" />
                  Contacts Sync
                </span>
                <Badge variant="outline" className="text-[10px] uppercase font-mono">
                  {contactsStatus}
                </Badge>
              </div>
              <p className="text-muted-foreground text-[11px]">
                {config?.contacts_synced_at
                  ? `Synced at ${new Date(config.contacts_synced_at).toLocaleTimeString()}`
                  : 'Phone contacts mirrored automatically.'}
              </p>
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground flex items-center gap-1.5">
                  <RefreshCw className="size-3.5 text-primary" />
                  Chat History Sync
                </span>
                <Badge variant="outline" className="text-[10px] uppercase font-mono">
                  {historyStatus} ({historyProgress}%)
                </Badge>
              </div>
              <div className="w-full bg-muted rounded-full h-1.5 mt-1 overflow-hidden">
                <div
                  className="bg-primary h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(historyProgress, historyStatus === 'completed' ? 100 : 5)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Maintenance & 14-day Inactivity Warning */}
          <Alert className="border-amber-600/30 bg-amber-950/20 py-2.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="size-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs">
                <AlertTitle className="text-amber-300 font-medium text-xs mb-0.5">
                  Keep WhatsApp Business App Active
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 leading-relaxed text-[11px]">
                  Open the WhatsApp Business App on your phone regularly (at least once every 10–14 days). Meta may automatically disconnect coexistence if the mobile app remains dormant.
                </AlertDescription>
              </div>
            </div>
          </Alert>

          {/* Limited Features Notice */}
          <div className="rounded-lg border border-border/80 bg-muted/20 p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Info className="size-3.5 text-muted-foreground shrink-0" />
              <span>Features limited by Meta on your phone during Coexistence:</span>
            </div>
            <ul className="list-disc list-inside space-y-0.5 text-muted-foreground text-[11px] pl-1 leading-relaxed">
              <li><strong>Broadcast Lists:</strong> Existing lists become read-only. Mass broadcasts must be sent from wacrm via approved Meta templates.</li>
              <li><strong>Disappearing Messages:</strong> Disabled for this number to maintain CRM message sync.</li>
              <li><strong>View-Once Media:</strong> Disabled because Cloud API cannot handle ephemeral media.</li>
              <li><strong>Live Location:</strong> Continuous location streaming is disabled.</li>
              <li><strong>Status / Stories:</strong> Visible on phone app only; does not sync to CRM.</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Not connected or in manual mode — show Primary Coexistence Onboarding Card:
  return (
    <Card className="border-primary/40 bg-gradient-to-b from-card to-muted/20 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Smartphone className="size-5" />
          </div>
          <div>
            <CardTitle className="text-base text-foreground">
              Connect existing WhatsApp Business App (Coexistence)
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">
              Keep your existing phone app active while connecting the same number to wacrm Cloud API.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Value proposition badges */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/60 p-2.5">
            <ShieldCheck className="size-4 text-emerald-400 shrink-0" />
            <span>Phone app stays logged in</span>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/60 p-2.5">
            <CheckCircle2 className="size-4 text-primary shrink-0" />
            <span>Chat history & contacts synced</span>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/60 p-2.5">
            <RefreshCw className="size-4 text-emerald-400 shrink-0" />
            <span>Two-way message mirroring</span>
          </div>
        </div>

        {/* Action Button */}
        <div className="pt-1">
          <Button
            onClick={handleStartCoexistence}
            disabled={connecting || !canEditSettings}
            className="w-full sm:w-auto bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-5 h-10"
          >
            {connecting ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" />
                Connecting via Meta Embedded Signup...
              </>
            ) : (
              <>
                <Smartphone className="size-4 mr-2" />
                Connect existing WhatsApp Business App number (Coexistence)
              </>
            )}
          </Button>

          {showQrNotice && (
            <Alert className="mt-3 border-primary/30 bg-primary/5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-foreground">
                <QrCode className="size-4 text-primary shrink-0" />
                <span>
                  You will scan a QR code / confirm inside your WhatsApp Business App on your phone. Your mobile app will stay logged in.
                </span>
              </div>
            </Alert>
          )}

          {!clientConfig?.configured && (
            <p className="text-[11px] text-muted-foreground mt-2">
              Note: Embedded signup requires <code>META_APP_ID</code> and <code>META_CONFIG_ID</code> in <code>.env.local</code>.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
