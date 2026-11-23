/**
 * Bot settings pane:
 * 1) Bot avatar style chosen from the bundled `bot-avatars` catalog (defaults to clover)
 * 2) Default execution model for delegated & follow-up project runs (inherits Pig global default when unset)
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { BotAvatar, botAvatarTypes, type BotAvatarType } from 'bot-avatars'
import { RotateCw } from 'lucide-react'
import {
  BOT_AVATAR_TYPES,
  DEFAULT_BOT_AVATAR,
  isBotAvatarId,
  type BotAvatarId,
  type BotPreferencesPatch
} from '../../../../shared/bot'
import type { MessageKey } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useSettingsStore } from '../../stores/settings'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { ModelThinkingPicker, supportedThinking } from './ModelThinkingPicker'
import { SettingsCard, SettingsRow } from './SettingsFields'

// Compile-time check keeping shared BotAvatarId aligned with the installed `bot-avatars` package.
const _SUPPORTED_CHECK: readonly BotAvatarType[] = BOT_AVATAR_TYPES
void _SUPPORTED_CHECK

const AVATAR_OPTIONS: BotAvatarId[] = botAvatarTypes.filter(isBotAvatarId)

function avatarLabelKey(id: BotAvatarId): MessageKey {
  return `bot.settings.avatars.${id}` as MessageKey
}

export function BotPane({ active = true }: { active?: boolean }) {
  const t = useT()
  const loaded = useBotStore((s) => s.loaded)
  const loading = useBotStore((s) => s.loading)
  const state = useBotStore((s) => s.state)
  const storeError = useBotStore((s) => s.error)
  const initBot = useBotStore((s) => s.init)
  const updatePreferences = useBotStore((s) => s.updatePreferences)

  const models = useModelCatalogStore((s) => s.models)
  const defaultModel = useSettingsStore((s) => s.defaultModel)

  const [saving, setSaving] = useState(false)
  const [errorKind, setErrorKind] = useState<'load' | 'save'>('load')
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const attemptedLoadRef = useRef(false)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Trigger initial load at most once when entering Settings; never restore lastSurface into Bot view.
  useEffect(() => {
    if (active && !loaded && !loading && !storeError && !attemptedLoadRef.current) {
      attemptedLoadRef.current = true
      setErrorKind('load')
      void initBot({ restoreSurface: false })
    }
  }, [active, loaded, loading, storeError, initBot])

  const retryLoad = () => {
    if (loading) return
    attemptedLoadRef.current = true
    setErrorKind('load')
    void initBot({ restoreSurface: false })
  }

  const ready = loaded && state !== null
  const selectedAvatar: BotAvatarId = state?.avatar ?? DEFAULT_BOT_AVATAR
  const activeAvatarIndex = Math.max(0, AVATAR_OPTIONS.indexOf(selectedAvatar))
  const delegateModelRef = state?.delegateModel
  const delegateModel = delegateModelRef
    ? models.find((item) => item.provider === delegateModelRef.provider && item.id === delegateModelRef.id) ?? null
    : null

  const save = async (patch: BotPreferencesPatch) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setErrorKind('save')
    try {
      await updatePreferences(patch)
    } catch {
      // Store retains the formatted failure message for alert rendering.
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  const handleAvatarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % AVATAR_OPTIONS.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + AVATAR_OPTIONS.length) % AVATAR_OPTIONS.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = AVATAR_OPTIONS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    if (savingRef.current) return
    optionRefs.current[nextIndex]?.focus()
    const nextAvatar = AVATAR_OPTIONS[nextIndex]
    if (nextAvatar && nextAvatar !== selectedAvatar) {
      void save({ avatar: nextAvatar })
    }
  }

  const defaultDescription = defaultModel
    ? t('bot.settings.delegateModelDefaultWith', { model: defaultModel.name })
    : t('bot.settings.delegateModelDefault')

  return (
    <div className="flex flex-col gap-8" aria-busy={saving || loading}>
      {storeError ? (
        <Alert variant="destructive">
          <AlertTitle>{t(errorKind === 'save' ? 'bot.settings.saveError' : 'bot.settings.loadError')}</AlertTitle>
          <AlertDescription>{storeError}</AlertDescription>
          {!ready ? (
            <AlertAction>
              <Button type="button" variant="outline" size="xs" disabled={loading} onClick={retryLoad}>
                <RotateCw data-icon="inline-start" />
                {t('common.retry')}
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}

      {!ready ? (
        loading ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t('bot.settings.loading')}
          </p>
        ) : null
      ) : (
        <>
          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('bot.settings.appearance')}
            </p>
            <SettingsCard>
              <div className="flex items-center gap-4 px-4 py-4">
                <BotAvatar
                  type={selectedAvatar}
                  size={40}
                  paused={!active}
                  interactive={false}
                  aria-hidden="true"
                  className="pointer-events-none shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{t('bot.settings.avatar')}</div>
                  <p className="text-xs text-muted-foreground">{t('bot.settings.avatarDescription')}</p>
                </div>
                <Badge variant="secondary" className="shrink-0 font-normal">
                  {t(avatarLabelKey(selectedAvatar))}
                </Badge>
              </div>
              <div
                role="radiogroup"
                aria-label={t('bot.settings.avatar')}
                className="grid grid-cols-3 gap-2 p-4 sm:grid-cols-6"
              >
                {AVATAR_OPTIONS.map((avatarId, index) => {
                  const selected = avatarId === selectedAvatar
                  const label = t(avatarLabelKey(avatarId))
                  return (
                    <button
                      key={avatarId}
                      ref={(el) => { optionRefs.current[index] = el }}
                      type="button"
                      role="radio"
                      tabIndex={index === activeAvatarIndex ? 0 : -1}
                      aria-checked={selected}
                      aria-disabled={saving || undefined}
                      aria-label={label}
                      data-bot-avatar-option={avatarId}
                      onKeyDown={(event) => handleAvatarKeyDown(event, index)}
                      onClick={() => {
                        if (savingRef.current || selected) return
                        void save({ avatar: avatarId })
                      }}
                      className={cn(
                        'flex flex-col items-center gap-1.5 rounded-xl border px-1.5 pt-3.5 pb-2 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring aria-disabled:opacity-60',
                        selected
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-transparent bg-glass-prompt-foreground/4 text-muted-foreground hover:bg-glass-prompt-foreground/8 hover:text-foreground solid:bg-muted/40 solid:hover:bg-accent solid:hover:text-accent-foreground'
                      )}
                    >
                      <BotAvatar
                        type={avatarId}
                        size={28}
                        paused={!active || !selected}
                        interactive={false}
                        aria-hidden="true"
                        className="pointer-events-none"
                      />
                      <span className="w-full truncate text-xs font-normal">{label}</span>
                    </button>
                  )
                })}
              </div>
            </SettingsCard>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('bot.settings.backgroundTasks')}
            </p>
            <SettingsCard>
              <SettingsRow
                title={t('bot.settings.delegateModel')}
                description={t('bot.settings.delegateModelDescription')}
              >
                <ModelThinkingPicker
                  model={delegateModel}
                  models={models}
                  label={delegateModelRef ? `${delegateModelRef.provider}/${delegateModelRef.id}` : undefined}
                  thinking={delegateModelRef ? (state.delegateThinkingLevel ?? null) : null}
                  disabled={saving}
                  defaultOption={{
                    active: !delegateModelRef,
                    description: defaultDescription,
                    onSelect: () => void save({ delegateModel: null, delegateThinkingLevel: null })
                  }}
                  onModelChange={(item) => {
                    const nextThinking = supportedThinking(item, state.delegateThinkingLevel ?? null)
                    void save({
                      delegateModel: { provider: item.provider, id: item.id },
                      delegateThinkingLevel: nextThinking
                    })
                  }}
                  onThinkingChange={(level) => {
                    if (delegateModelRef) void save({ delegateThinkingLevel: level })
                  }}
                />
              </SettingsRow>
            </SettingsCard>
          </div>
        </>
      )}
    </div>
  )
}
