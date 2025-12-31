import { lazy, Suspense } from 'react'

const AppWrapperLazy = lazy(() => import('./main'))

export default function MainWrapper() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <AppWrapperLazy />
    </Suspense>
  )
}
