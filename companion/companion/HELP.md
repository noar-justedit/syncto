## syncto

Starts synchronizations in [syncto](https://github.com/noar-justedit/syncto) and shows their state on the buttons.

**In syncto** (1.1.0 or later): Settings › Remote control, turn on **Companion**. If Companion runs on another computer, also turn on **Other machines**. Copy the address, the port and the key shown there into this connection.

**Actions**
- *Synchronize a job*: compares, then synchronizes a job saved in syncto (the jobs listed on the left of syncto).
- *Compare a job only*.
- *Stop*, *Pause*, *Resume*.

**Feedbacks**: the state of syncto (comparing, synchronizing, paused), a given job running, how the last run ended.

**Variables**: `$(syncto:state)`, `$(syncto:job)`, `$(syncto:progress)`, `$(syncto:eta)`, `$(syncto:speed)`, `$(syncto:last_result)`, `$(syncto:last_message)`.

**Presets**: one button per job (green while it runs, with its progress), Stop, Status.

A run started from Companion is refused when it would remove more than half of the files: check the folders in syncto first. syncto has to be open for Companion to reach it.
