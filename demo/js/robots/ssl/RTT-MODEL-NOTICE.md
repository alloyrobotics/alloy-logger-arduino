# Robot model: RoboTeam Twente, Full Assembly (2024)

The SSL robot rendered on "Understand the robot" is RoboTeam Twente's own published CAD, converted
to a wireframe display asset (`rtt-model.mesh`) by `assets-src/rtt/` in this repository. Nothing about
the robot's shape is authored here: the geometry is theirs, tessellated and grouped, and the pipeline
that did it is committed beside the STEP it read.

Source: RoboTeam Twente, Full Assembly (2024)
Upstream: https://github.com/RoboTeamTwente/roboteam_hardware
License: MIT

WHAT WAS CHANGED. The published Full Assembly is a manufacturing model: 972 leaf parts including
fasteners, bearings and every SMD component on five circuit boards. The display asset keeps 184 of
them - the chassis plates, the four omni wheel assemblies with their rollers, the solenoid kicker and
its capacitor bank, the dribbler mouth, and the top-plate control boards - tessellated at a coarse
chord error and grouped into the five layers the anatomy tour lights. Fasteners, PCB component
footprints and parts under 14 mm are dropped, as is the CAD's own golf ball: the demo scene has its
own tracked ball from the match log, and a ball welded into the robot's geometry would be a pose the
log never recorded.

ONE GROUP IS NOT A PART OF THIS CAD, and it is called out here rather than glossed. The anatomy
tour's `imu` card names an inertial measurement unit. This published assembly names no IMU anywhere -
there is no imu, gyro, BNO, MPU, LSM or ICM part among its 972 leaves - so the group the card lights
is the top-plate control electronics it sits on: the BeagleBone that closes the motion loop and the
motor-driver boards beside it. The marker over it is the anatomy overlay's own anchored halo, which
is how that overlay has always pointed at a part it does not model.

MIT License

Copyright (c) 2024 RoboTeam Twente

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
