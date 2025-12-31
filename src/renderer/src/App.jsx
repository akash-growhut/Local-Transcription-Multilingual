import { HashRouter as Router, Routes, Route } from 'react-router-dom'
import RecordingPage from './RecordingPage'

const App = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<RecordingPage />} />
      </Routes>
    </Router>
  )
}

export default App
