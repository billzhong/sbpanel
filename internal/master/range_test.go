package master

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"sbpanel/internal/pb"
)

// Minute-precise ranges: series and exact dims use minute data; host dims use 5-minute data.
func TestMinuteRangeQueries(t *testing.T) {
	m := newTestMaster(t)
	seedNode(t, m, "n1")
	m.db.Exec(`INSERT INTO users(id, username, sub_token, uuid, password, created_at) VALUES(1,'u','t','x','y',0)`)
	base := time.Now().Add(-48*time.Hour).Unix() / 3600 * 3600 // an hour boundary two days ago
	// one report per minute for 30 minutes, 1000 bytes each, alternating hosts
	for i := 0; i < 30; i++ {
		host := "a.com"
		if i%2 == 1 {
			host = "b.com"
		}
		rep := &pb.TrafficReport{Seq: uint64(i + 1), WindowStart: base + int64(i)*60,
			Users: []*pb.UserStat{{User: "1", Inbound: "in", Outbound: "direct", Down: 1000}},
			Dims:  []*pb.DimStat{{User: "1", Inbound: "in", Outbound: "direct", Host: host, Port: 443, Down: 1000}}}
		if _, err := m.ingest("n1", rep); err != nil {
			t.Fatal(err)
		}
	}
	// [base+7min, base+19min): 12 minutes -> 12000 bytes, exact
	from, to := base+7*60, base+19*60
	q := "from=" + strconv.FormatInt(from, 10) + "&to=" + strconv.FormatInt(to, 10)
	rec := httptest.NewRecorder()
	m.apiSeries(rec, httptest.NewRequest("GET", "/api/traffic/series?step=60&group=total&"+q, nil))
	var s struct {
		Series []struct {
			Down   int64      `json:"down"`
			Points [][3]int64 `json:"points"`
		} `json:"series"`
	}
	json.Unmarshal(rec.Body.Bytes(), &s)
	if len(s.Series) != 1 || s.Series[0].Down != 12000 || len(s.Series[0].Points) != 12 {
		t.Fatalf("minute series: %s", rec.Body.String())
	}
	// coarser step over the same exact range stays exact (aggregated from minutes)
	rec = httptest.NewRecorder()
	m.apiSeries(rec, httptest.NewRequest("GET", "/api/traffic/series?step=3600&group=user&"+q, nil))
	json.Unmarshal(rec.Body.Bytes(), &s)
	if s.Series[0].Down != 12000 {
		t.Fatalf("hour-step over minute range: %s", rec.Body.String())
	}
	// exact dim: user total over the range, minute precision
	rec = httptest.NewRecorder()
	m.apiTop(rec, httptest.NewRequest("GET", "/api/traffic/top?dim=user&"+q, nil))
	var top []topRow
	json.Unmarshal(rec.Body.Bytes(), &top)
	if len(top) != 1 || top[0].Down != 12000 || rec.Header().Get("X-Precision") != "1m" {
		t.Fatalf("user top %s (%s)", rec.Body.String(), rec.Header().Get("X-Precision"))
	}
	// host dim: 5-minute buckets -> range widened to [5min, 20min) = 15 minutes
	rec = httptest.NewRecorder()
	m.apiTop(rec, httptest.NewRequest("GET", "/api/traffic/top?dim=host&"+q, nil))
	json.Unmarshal(rec.Body.Bytes(), &top)
	var sum int64
	for _, r := range top {
		sum += r.Down
	}
	if sum != 15000 || rec.Header().Get("X-Precision") != "5m" {
		t.Fatalf("host top sum %d (%s): %s", sum, rec.Header().Get("X-Precision"), rec.Body.String())
	}
	// validation
	for _, bad := range []string{"step=7&" + q, "step=60&from=100&to=50", "step=60&from=0&to=" + strconv.FormatInt(time.Now().Unix(), 10)} {
		rec = httptest.NewRecorder()
		m.apiSeries(rec, httptest.NewRequest("GET", "/api/traffic/series?"+bad, nil))
		if rec.Code != 400 {
			t.Errorf("%s -> %d", bad, rec.Code)
		}
	}
	// ranges older than the minute window report hour precision
	f := trafficFilter{from: time.Now().Add(-40 * 24 * time.Hour).Unix(), to: time.Now().Unix()}
	if m.topPrecision(f, "host") != "1h" || m.topPrecision(f, "user") != "1h" {
		t.Fatal("old range precision")
	}
}
