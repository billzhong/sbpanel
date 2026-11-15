import { Fragment, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from './ui/kit'
import { App } from './App'
import { useLang } from './i18n'
import './index.css'

/** Remounts the app when the language changes, so every label (including tr() in helpers) re-renders. */
function LangRoot({ children }: { children: ReactNode }) {
  return <Fragment key={useLang()}>{children}</Fragment>
}

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 4000, refetchOnWindowFocus: true, retry: 1 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <LangRoot><App /></LangRoot>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
