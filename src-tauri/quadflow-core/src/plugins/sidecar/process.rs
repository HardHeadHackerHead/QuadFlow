//! Spawning sidecar processes so they never outlive QuadFlow (plugin-system.md §10.2).
//!
//! - Windows: `CREATE_NO_WINDOW`, and the child is assigned to its own Job
//!   Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The job handle lives in
//!   this process, so when QuadFlow exits — cleanly, by crash or by
//!   `taskkill /F` — the OS closes it and kills the sidecar and every process
//!   it started — except programs it launches with `CREATE_BREAKAWAY_FROM_JOB`
//!   (the job allows breakaway: apps a plugin opens for the user survive QuadFlow).
//! - Unix: the child leads its own process group (killed as a group); on Linux
//!   it also gets `PR_SET_PDEATHSIG(SIGKILL)`.

use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

/// Everything needed to start one sidecar process (argv, no shell).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidecarLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

/// Kills the whole process tree of one sidecar.
pub struct ProcessTree {
    pid: u32,
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl ProcessTree {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Kill the sidecar and its descendants (idempotent; errors ignored).
    pub fn kill(&self) {
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                job.terminate();
            }
        }
        #[cfg(unix)]
        unsafe {
            // Negative pid = the process group the child leads.
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
    }
}

/// Spawn with piped stdio. The returned [`ProcessTree`] must be kept for the
/// process' lifetime (on Windows dropping it closes the job, which kills the tree).
pub fn spawn(launch: &SidecarLaunch) -> io::Result<(Child, ProcessTree)> {
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .current_dir(&launch.cwd)
        .envs(&launch.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn()?;
    let pid = child.id();
    #[cfg(windows)]
    {
        match win::Job::for_child(&child) {
            Ok(job) => Ok((child, ProcessTree { pid, job: Some(job) })),
            Err(e) => {
                // Never run a sidecar that would outlive the app.
                let _ = child.kill();
                let _ = child.wait();
                Err(io::Error::other(format!("assign sidecar to a job object: {e}")))
            }
        }
    }
    #[cfg(not(windows))]
    {
        Ok((child, ProcessTree { pid }))
    }
}

#[cfg(windows)]
mod win {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // The handle is only used through thread-safe kernel calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn for_child(child: &Child) -> io::Result<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                // BREAKAWAY_OK: a program the sidecar launches on purpose with
                // `CREATE_BREAKAWAY_FROM_JOB` (an app the user opened) outlives QuadFlow;
                // everything else in the job is killed with it.
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
