+++
title = 'APRS'
date = 2025-03-23T09:45:00+01:00
draft = false
summary = "Initial experiments with APRS using Dire Wolf and SignaLink USB."
tags = ['aprs', 'dire wolf', 'ax.25', 'SignaLink', 'location']
+++

# First experiments with APRS

After success with Winlink [described in a previous post]({{< ref "/posts/winlink" >}}), I wanted to try out APRS (Automatic Packet Reporting System). The components are exactly the same as with my Winlink experiment:
* Laptop running Dire Wolf
* SignaLink USB
* Yaesu FT-70D VHF/UHF radio

Then it was just a matter of configuring the `direwolf.conf` with this line:

```
PBEACON delay=01:00 every=15 symbol="/-" lat=59^56.60N long=010^46.60E power=5 alt=60 gain=2.15 comment="APRS test" via=WIDE1-1
```

For Norway, the frequency is 144.800 MHz. This can be found in the [band plans for Norway that NRRL maintains](https://nrrl.no/tema/bandplaner/).

With this setup, my position will be transmitted every 15 minutes, and I can also receive messages. The part where it says `via=WIDE1-1` means that the APRS packet can be forwarded by a maximum of one digipeater.

For APRS one should use what is called _Secondary Station Identifier_ or SSID. This is a convention to make it easier to see what type of APRS application is in use. The SSID for my stationary APRS would then be _LB2KK-0_ or just _LB2KK_. If I had a weather station, it would be _LB2KK-13_ and so on. See [APRS SSID Recommendations](https://www.aprs.org/aprs11/SSIDs.txt) for the full list.

# Use cases for APRS

Most examples that I found are about position tracking. This can be used for cars, boats, humans, and your QTH. Another common example is weather stations that send temperature, wind speed, etc. These are examples of one-way communication. It is possible to use it as a two-way communication system as well. I can for example broadcast the frequency I'm listening to when mobile. [LA4A](https://www.la4a.no/2021/01/01/introduksjon-til-aprs/) uses APRS to broadcast information about their repeaters which can be used to automatically configure the frequency offset, TSQL, TONE, etc. One such repeater is [LA5AR](https://aprs.fi/info/a/LA5AR) which has `145.700MHz t123 -0600kHz NETSu8PM` in the APRS object. It even contains the time for the local net: Sundays at 8 PM.


# Links

General APRS information:
* Live map: https://aprs.fi/

Some information about the use of APRS in Norway:
* https://nrrl.no/tema/kart-og-posisjonering/
* https://www.la4a.no/2021/01/01/introduksjon-til-aprs/

