package main

// The socket reader stays free to process proof challenges and ping frames.
// Completion is joined before the resident reconnects or exits.
type installJob struct {
	done   chan struct{}
	result error
}

func startInstallJob(install func() error, wakeReader func()) *installJob {
	job := &installJob{done: make(chan struct{})}
	go func() {
		job.result = install()
		close(job.done)
		wakeReader()
	}()
	return job
}
func (job *installJob) wait() error { <-job.done; return job.result }
