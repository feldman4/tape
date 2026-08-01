# iPad Control Appendix

Tape on iPad is a landscape-only instrument surface. The control layout is
available in the **TAPE** view: lane and edit controls stay at the screen
edges, the circular swipe control provides continuous tape-like movement, and
view tabs remain along the bottom.

## Layout

| Area | Control | Action |
| --- | --- | --- |
| Left edge | Tape 1 to 4 | Select lane 1 to 4; with Shift, mute or unmute that lane |
| Top left | Record | Arm, start, or stop recording as the transport state permits |
| Centre | Circular swipe control | Scrub the playhead or shift the loop region |
| Right edge | Lift | Lift selected clip; with Shift, Lift All in the loop region |
| Right edge | Drop | Drop clipboard; with Shift, Merge Drop |
| Right edge | Split | Split selected clip; with Shift, Join with a neighbour |
| Right edge | Undo | Undo; with Shift, Redo |
| Top right | Loop | Toggle loop playback; with Shift, set the loop to the selected clip |
| Bottom left or bottom right | Shift | Hold while using another control for its Shift action |
| Bottom edge | Snap | Toggle beat Snap |
| Bottom edge | Free / Sync | Toggle Free and Sync mode |
| Bottom | Tabs | Select TAPE, MIXER, PROJ, COM, or TEST |

The left and right bottom-corner Shift controls are interchangeable. Hold
either one while touching another control; release it to return to that
control's normal action.

Play, Pause, Stop, and Click controls remain between the main tape and minimap
views, as on the existing Tape screen.

## Circular Swipe Control

The circular swipe control is a continuous relative control, intended to feel
like turning a tape reel rather than pressing a fixed command. Its motion is
angular: movement around the fixed centre changes the selected value according
to the direction and amount of rotation, not the finger's absolute position or
linear drag distance. Start a swipe in the required sector and move around the
circle in either direction. The sector selected at touch-down remains active
for the entire swipe, even when the finger crosses a sector divider.

The visual marks the fixed swipe coordinate system with two faint concentric
circles and a horizontal sector divider. The inner circle is a centre dead
zone; the region beyond the outer circle is an outer dead zone. Only the ring
between them responds to reel motion. A swipe can enter either dead zone and
return to the live ring without ending; angular motion continues from its last
live position. The circles and divider remain fixed while the finger moves and
do not mark the current touch position.

| Sector | Normal action | Hold Shift |
| --- | --- | --- |
| Top | Scrub the playhead | Slide the selected clip and playhead together |
| Bottom | Shift the entire loop region | Move loop out |

With Snap on, circular movement adjusts positions in beat steps. With Snap
off, it uses small timeline steps. The interaction remains continuous during a
single swipe, so a longer sweep produces more movement without requiring
repeated touches.

## Visible State

The iPad surface visibly indicates the selected lane, muted lanes, recording
state, loop enabled state, active Shift state, Snap state, and Free or Sync
mode. During a reel gesture, the active sector is also indicated. Controls that
cannot currently act, such as an edit command without a selected clip, show an
unavailable state.
